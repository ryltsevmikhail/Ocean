import { createHash } from 'node:crypto';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  readCodingBackupInventory,
  snapshotCodingDatabase,
  snapshotDatabase,
  inspectDatabase,
} from '@runnets/store-sqlite';
import { codingWorkflowFixture, initialMath } from './coding-workflow-fixture.js';
it('binds all task/worktree/artifact references from a closed profile without reading project files', async () => {
  const f = await codingWorkflowFixture('direct');
  try {
    const path = join(f.directory, 'runtime.sqlite');
    await expect(async () => readCodingBackupInventory(path)).rejects.toThrow('owner_busy');
    rmSync(join(f.worktree, 'math.cjs'));
    writeFileSync(join(f.worktree, 'command'), 'synthetic executable');
    chmodSync(join(f.worktree, 'command'), 0o755);
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
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(inventory.changesets[0]?.files).toEqual([
      {
        path: 'command',
        before: null,
        after: { mode: '100755', sha256: sha256('synthetic executable') },
      },
      { path: 'math.cjs', before: { mode: '100644', sha256: sha256(initialMath) }, after: null },
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

it('freezes ordered receipt paths, states and exact v2 or unmarked protocol from SQLite alone', async () => {
  const f = await codingWorkflowFixture('direct');
  try {
    writeFileSync(join(f.worktree, 'a'), 'a');
    writeFileSync(join(f.worktree, 'b'), 'b');
    const artifact = await f.capture('capture');
    const path = join(f.directory, 'runtime.sqlite');
    f.runtime.close();
    rmSync(f.project, { recursive: true });
    const db = new DatabaseSync(path);
    const files = [
      { path: 'a', status: 'completed' },
      { path: 'b', status: 'started' },
    ];
    const receipt = {
      id: 'apply',
      taskId: 'task',
      changesetHash: artifact.hash,
      expectedBase: f.base,
      status: 'applying',
      files,
    };
    try {
      const write = db.prepare('INSERT OR REPLACE INTO ocean_coding_applications VALUES(?,?)');
      write.run('apply', JSON.stringify(receipt));
      const old = readCodingBackupInventory(path);
      expect(old.applications[0]).toMatchObject({ recoveryProtocol: null, files });
      write.run('apply', JSON.stringify({ ...receipt, recoveryProtocol: 2 }));
      const marked = readCodingBackupInventory(path);
      expect(marked.applications[0]).toMatchObject({ recoveryProtocol: 2, files });
      expect(marked.hash).not.toBe(old.hash);
      expect(readCodingBackupInventory(path)).toEqual(marked);
      for (const recoveryProtocol of ['2', null, [2], 1]) {
        write.run('apply', JSON.stringify({ ...receipt, recoveryProtocol }));
        expect(() => readCodingBackupInventory(path)).toThrow('invalid_coding_inventory');
      }
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

it('rejects invalid file content identities even inside a self-consistent changeset envelope', async () => {
  const f = await codingWorkflowFixture('direct');
  try {
    writeFileSync(join(f.worktree, 'file'), 'synthetic');
    const artifact = await f.capture('capture');
    f.runtime.close();
    const path = join(f.directory, 'runtime.sqlite'),
      db = new DatabaseSync(path);
    try {
      const { id: _id, hash: _hash, ...body } = artifact;
      for (const after of [
        { ...body.files[0]!.after, sha256: '0'.repeat(64) },
        { ...body.files[0]!.after, mode: ['100644'] },
      ]) {
        const payload = { ...body, files: [{ ...body.files[0], after }] };
        const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        db.prepare('INSERT INTO ocean_changesets VALUES(?,?,?)').run(
          hash,
          'task',
          JSON.stringify({ id: hash, hash, ...payload }),
        );
        expect(() => readCodingBackupInventory(path)).toThrow('invalid_coding_inventory');
        db.prepare('DELETE FROM ocean_changesets WHERE hash=?').run(hash);
      }
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});
