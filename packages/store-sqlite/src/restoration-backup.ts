import { DatabaseSync } from 'node:sqlite';
import type {
  RestorationBackupState,
  RestoreOrigin,
  ProfileRebindRecord,
  ProfileRebindObservation,
} from '@runnets/domain';
import { restoreOriginStore } from './restore-origin.js';
import { ownerBusy } from './maintenance-owner.js';
export function readRestorationBackupState(path: string): RestorationBackupState {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (ownerBusy(db)) throw Error('owner_busy');
    return restorationBackupState(db);
  } finally {
    db.close();
  }
}
/** Count and byte metadata admission precedes every restoration payload read. No referenced path is opened. */
export function restorationBackupState(db: DatabaseSync): RestorationBackupState {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ocean_restore_origin'")
      .get()
  )
    return {
      origin: null,
      origins: [],
      records: [],
      observations: [],
      activeRequestId: null,
      retired: [],
    };
  const tables = [
    'ocean_restore_origin',
    'ocean_restore_origins',
    'ocean_profile_rebinds',
    'ocean_rebind_observations',
    'ocean_retired_epochs',
  ] as const;
  let bytes = 0;
  for (const table of tables) {
    const sizes = db
      .prepare(`SELECT length(CAST(payload AS BLOB)) AS bytes FROM ${table} LIMIT 10001`)
      .all();
    if (sizes.length > (table === 'ocean_rebind_observations' ? 10000 : 1000))
      throw Error('restoration_inventory_limit');
    for (const r of sizes) {
      const n = Number(r['bytes']);
      bytes += n;
      if (!Number.isSafeInteger(n) || n > 16777216 || bytes > 33554432)
        throw Error('restoration_inventory_limit');
    }
  }
  const read = <T>(table: (typeof tables)[number], key: string): T[] =>
    db
      .prepare(`SELECT payload FROM ${table} ORDER BY ${key}`)
      .all()
      .map((r) => JSON.parse(String(r['payload'])) as T);
  const active = db.prepare('SELECT request_id FROM ocean_execution_epoch WHERE singleton=1').get();
  return {
    origin: restoreOriginStore(db).origin(),
    origins: read<RestoreOrigin>('ocean_restore_origins', 'identity'),
    records: read<ProfileRebindRecord>('ocean_profile_rebinds', 'request_id'),
    observations: read<ProfileRebindObservation>('ocean_rebind_observations', 'id'),
    activeRequestId: active ? String(active['request_id']) : null,
    retired: read<RestorationBackupState['retired'][number]>('ocean_retired_epochs', 'identity'),
  };
}
