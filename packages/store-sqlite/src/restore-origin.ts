import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validProfileBackupManifest, type RestoreOrigin } from '@runnets/domain';
import type { RestoreOriginStore } from '@runnets/application';
import { withImmediateTransaction } from './transaction.js';
import { migrateRebinds } from './profile-rebind.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function migrateRestoration(db: DatabaseSync): void {
  db.exec(`CREATE TABLE ocean_restore_origin (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE ocean_restore_origins(identity TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;
  CREATE TABLE ocean_retired_epochs(identity TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT`);
  migrateRebinds(db);
}
function validate(value: RestoreOrigin): RestoreOrigin {
  if (
    value.version !== 1 ||
    !validProfileBackupManifest(value.manifest) ||
    value.manifest.format !== 2 ||
    value.snapshotId !== hash(JSON.stringify(value.manifest)) ||
    typeof value.profileRoot !== 'string' ||
    !value.profileRoot.startsWith('/') ||
    value.profileId !== hash(value.profileRoot) ||
    !Array.isArray(value.sourceOwners) ||
    value.sourceOwners.length > 1000 ||
    value.sourceOwners.some(
      (id) => typeof id !== 'string' || !id || id.length > 4096 || id.includes('\0'),
    ) ||
    new Set(value.sourceOwners).size !== value.sourceOwners.length
  )
    throw Error('invalid_restore_origin');
  return value;
}
export function restoreOriginStore(db: DatabaseSync): RestoreOriginStore {
  return {
    origin() {
      const row = db.prepare('SELECT payload FROM ocean_restore_origin WHERE singleton=1').get();
      return row ? validate(JSON.parse(String(row['payload'])) as RestoreOrigin) : null;
    },
    install(origin) {
      const payload = JSON.stringify(validate(structuredClone(origin)));
      withImmediateTransaction(db, () => {
        const old = db.prepare('SELECT payload FROM ocean_restore_origin WHERE singleton=1').get();
        if (old && String(old['payload']) === payload) throw Error('restore_origin_exists');
        const active = db
          .prepare('SELECT request_id FROM ocean_execution_epoch WHERE singleton=1')
          .get();
        if (active) {
          if (!old) throw Error('invalid_execution_epoch');
          const retired = JSON.stringify({
            originHash: hash(String(old['payload'])),
            requestId: String(active['request_id']),
            retiredBy: origin.profileId,
            snapshotId: origin.snapshotId,
          });
          db.prepare('INSERT INTO ocean_retired_epochs VALUES(?,?)').run(hash(retired), retired);
          db.exec('DELETE FROM ocean_execution_epoch');
        }
        if (old)
          db.prepare('INSERT OR IGNORE INTO ocean_restore_origins VALUES(?,?)').run(
            hash(String(old['payload'])),
            String(old['payload']),
          );
        db.prepare('INSERT INTO ocean_restore_origins VALUES(?,?)').run(hash(payload), payload);
        db.prepare(
          'INSERT INTO ocean_restore_origin VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload',
        ).run(payload);
      });
    },
  };
}
