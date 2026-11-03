import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  openSqliteStore,
  ownSqliteRuntime,
  snapshotCodingDatabase,
  readCodingBackupInventory,
  inspectDatabase,
} from './index.js';
it('holds source ownership throughout asset capture and binds a standalone frozen database inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-coding-snapshot-'));
  const path = join(root, 'runtime.sqlite'),
    destination = join(root, 'snapshot.sqlite');
  try {
    openSqliteStore({ path }).close();
    const result = await snapshotCodingDatabase(path, destination, async (inventory) => {
      expect(inspectDatabase(path).status).toBe('owner_busy');
      expect(() => ownSqliteRuntime(path)).toThrow('owned by a live or unverified process');
      expect(readCodingBackupInventory(destination)).toEqual(inventory);
      return { capturedInventory: inventory.hash };
    });
    expect(result.assets.capturedInventory).toBe(result.inventory.hash);
    expect(inspectDatabase(path).status).toBe('ok');
    expect(inspectDatabase(destination)).toMatchObject({ status: 'ok', summary: result.summary });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('rejects mutation of the frozen database by the asset callback and releases source ownership on failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-coding-snapshot-mutation-'));
  const path = join(root, 'runtime.sqlite'),
    destination = join(root, 'snapshot.sqlite');
  try {
    openSqliteStore({ path }).close();
    await expect(
      snapshotCodingDatabase(path, destination, async () => {
        const db = new DatabaseSync(destination);
        try {
          db.exec("INSERT INTO meta VALUES('unexpected','mutation')");
        } finally {
          db.close();
        }
        return null;
      }),
    ).rejects.toThrow('snapshot_mismatch');
    expect(inspectDatabase(path).status).toBe('ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
