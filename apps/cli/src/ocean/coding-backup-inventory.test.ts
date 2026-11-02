import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  readCodingBackupInventory,
  snapshotCodingDatabase,
  snapshotDatabase,
  inspectDatabase,
} from '@runnets/store-sqlite';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
it('binds all task/worktree/artifact references from a closed profile without reading project files', async () => {
  const f = await codingWorkflowFixture('direct');
  try {
    const path = join(f.directory, 'runtime.sqlite');
    await expect(async () => readCodingBackupInventory(path)).rejects.toThrow('owner_busy');
    const artifact = await f.capture('capture');
    f.runtime.close();
    rmSync(f.project, { recursive: true });
    const inventory = readCodingBackupInventory(path);
    expect(inventory.tasks).toMatchObject([
      { id: 'task', projectRoot: f.project, worktreeRoot: f.worktree },
    ]);
    expect(inventory.worktrees).toMatchObject([
      { taskId: 'task', root: f.worktree, state: 'ready' },
    ]);
    expect(inventory.changesets).toMatchObject([
      { hash: artifact.hash, taskId: 'task', baseCommit: f.base },
    ]);
    expect(inventory.applications).toEqual([]);
    expect(readCodingBackupInventory(path)).toEqual(inventory);
    await expect(snapshotDatabase(path, join(f.directory, 'legacy.sqlite'))).rejects.toThrow(
      'coding_assets_unavailable',
    );
    const captured = await snapshotCodingDatabase(
      path,
      join(f.directory, 'frozen.sqlite'),
      async (refs) => {
        expect(inspectDatabase(path).status).toBe('owner_busy');
        expect(refs).toEqual(inventory);
        return { inventoryHash: refs.hash };
      },
    );
    expect(captured.inventory).toEqual(inventory);
    expect(captured.summary.externalCodingAssets).toBe(1);
    const db = new DatabaseSync(path);
    try {
      db.prepare(
        "UPDATE ocean_changesets SET payload=json_set(payload,'$.afterTreeHash','corrupt')",
      ).run();
    } finally {
      db.close();
    }
    expect(() => readCodingBackupInventory(path)).toThrow('invalid_coding_inventory');
  } finally {
    f.close();
  }
});

it('bounds record enumeration before loading or validating unbounded payload history', async () => {
  const f = await codingWorkflowFixture('direct');
  try {
    const path = join(f.directory, 'runtime.sqlite');
    f.runtime.close();
    const db = new DatabaseSync(path);
    try {
      db.exec('BEGIN');
      const insert = db.prepare('INSERT INTO ocean_changesets VALUES(?,?,?)');
      for (let index = 0; index < 10001; index++) insert.run('padding-' + index, 'task', '{}');
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    expect(() => readCodingBackupInventory(path)).toThrow('coding_inventory_limit');
  } finally {
    f.close();
  }
});
