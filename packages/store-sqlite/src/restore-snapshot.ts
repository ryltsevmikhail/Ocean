import { DatabaseSync } from 'node:sqlite';
import type { RestoredSnapshotState } from '@runnets/domain';
import { readMaintenanceCodingInventory } from './coding-backup-inventory.js';
import { desktopInventory } from './desktop-inventory.js';
import { task } from './coding-store.js';
import { ownerBusy } from './maintenance-owner.js';
import { restorationBackupState } from './restoration-backup.js';

/** The caller holds and verifies the frozen database descriptor throughout this synchronous read. */
export function readProfileRestoreSnapshot(path: string): RestoredSnapshotState {
  if (!/^\/proc\/self\/fd\/[0-9]+$/.test(path)) throw Error('restore_snapshot_descriptor_required');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (ownerBusy(db)) throw Error('owner_busy');
    if (db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok')
      throw Error('invalid_restore_origin');
    const coding = readMaintenanceCodingInventory(db);
    // Inventory validation already bounded every task's payload before decoding it.
    const tasks = coding.tasks.map(({ id }) => {
      const value = task(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id));
      if (!value) throw Error('invalid_restore_origin');
      return value;
    });
    return {
      coding,
      tasks,
      desktop: desktopInventory(db),
      restoration: restorationBackupState(db),
    };
  } finally {
    db.close();
  }
}
