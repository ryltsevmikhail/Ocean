import { applyMigrations } from './schema-migrations.js';
import { userTables } from './schema-inspection.js';
import { SCHEMA_VERSION } from './schema.js';
import type { DatabaseSync } from 'node:sqlite';
import type { DesktopAssetInventory, DesktopBinding } from '@runnets/domain';
import { desktopInventory } from './desktop-inventory.js';
/** The host supplies filesystem evidence; this adapter owns the transaction and exact-value CAS. */
export type DesktopBindingUpgrade = (
  binding: DesktopBinding,
  inventory: () => DesktopAssetInventory,
) => {
  readonly binding: DesktopBinding;
  verify(): void;
  close(): void;
} | null;
export function upgradeDesktopBinding(
  db: DatabaseSync,
  prepare: DesktopBindingUpgrade,
): 'upgraded' | 'unchanged' | 'legacy-ready' {
  db.exec('BEGIN IMMEDIATE');
  let held: ReturnType<DesktopBindingUpgrade> = null;
  try {
    const owner = db.prepare('SELECT owner,pid FROM runtime_owner_v1 WHERE singleton=1').get();
    if (owner?.['pid'] !== process.pid) throw Error('owner_required');
    const version = Number(
      db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    );
    // Older maintenance snapshots remain legacy; normal owner startup performs their full schema migration.
    if (version < 18) {
      db.exec('COMMIT');
      return 'unchanged';
    }
    const size = db
      .prepare(
        "SELECT length(CAST(value AS BLOB)) AS bytes FROM meta WHERE key='desktop_assets_binding'",
      )
      .get()?.['bytes'];
    if (Number(size ?? 0) > 16384) throw Error('desktop_inventory_limit');
    const raw = db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get()?.[
      'value'
    ];
    if (!raw) {
      db.exec('COMMIT');
      return 'unchanged';
    }
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='ocean_execution_epoch'").get() &&
      db.prepare('SELECT 1 FROM ocean_execution_epoch WHERE singleton=1').get()
    ) {
      // Immutable ready results and their meta copy must remain byte-identical.
      db.exec('COMMIT');
      return 'legacy-ready';
    }
    const old = JSON.parse(String(raw)) as DesktopBinding;
    held = prepare(structuredClone(old), () => desktopInventory(db));
    if (!held) {
      db.exec('COMMIT');
      return 'unchanged';
    }
    if (
      held.binding.profileId !== old.profileId ||
      held.binding.root !== old.root ||
      held.binding.originalRoot !== old.originalRoot ||
      held.binding.identity === old.identity
    )
      throw Error('desktop_binding_mismatch');
    held.verify();
    const result = db
      .prepare("UPDATE meta SET value=? WHERE key='desktop_assets_binding' AND value=?")
      .run(JSON.stringify(held.binding), raw);
    if (
      result.changes !== 1 ||
      db.prepare('SELECT owner FROM runtime_owner_v1 WHERE singleton=1').get()?.['owner'] !==
        owner['owner']
    )
      throw Error('desktop_binding_conflict');
    if (version < SCHEMA_VERSION) {
      applyMigrations(db, version, userTables(db));
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('invalid_database');
      db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
    }
    held.verify();
    db.exec('COMMIT');
    return 'upgraded';
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    held?.close();
  }
}
