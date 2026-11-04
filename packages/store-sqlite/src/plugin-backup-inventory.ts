import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  validPluginBackupInventory,
  type PluginBackupInventory,
  type PluginBackupVersion,
} from '@runnets/domain';
import { ownerBusy } from './maintenance-owner.js';
import { SCHEMA_VERSION } from './schema.js';

const MAX_VERSIONS = 64;

/** Read only verified snapshot metadata; never opens a path referenced by contents. */
export function readPluginBackupInventory(path: string): PluginBackupInventory {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (ownerBusy(db)) throw Error('owner_busy');
    return readMaintenancePluginInventory(db);
  } finally {
    db.close();
  }
}

/** Internal only: the caller already holds the snapshot/ownership connection. */
export function readMaintenancePluginInventory(db: DatabaseSync): PluginBackupInventory {
  const version = Number(
    db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
  );
  if (!Number.isSafeInteger(version) || version < 1 || version > SCHEMA_VERSION)
    throw Error('unsupported_schema');
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ocean_plugin_versions'")
    .get();
  if (table === undefined) return inventory([]);
  const rows = db
    .prepare(
      `SELECT plugin_id, version, manifest_digest, state, enabled
       FROM ocean_plugin_versions ORDER BY plugin_id, version LIMIT ?`,
    )
    .all(MAX_VERSIONS + 1);
  if (rows.length > MAX_VERSIONS) throw Error('plugin_inventory_limit');
  const versions: PluginBackupVersion[] = [];
  for (const row of rows) {
    if (
      typeof row['plugin_id'] !== 'string' ||
      typeof row['version'] !== 'string' ||
      typeof row['manifest_digest'] !== 'string' ||
      typeof row['state'] !== 'string' ||
      typeof row['enabled'] !== 'number'
    )
      throw Error('invalid_plugin_inventory');
    versions.push({
      pluginId: String(row['plugin_id']),
      version: String(row['version']),
      manifestDigest: String(row['manifest_digest']),
      state: String(row['state']) as PluginBackupVersion['state'],
      enabled: Number(row['enabled']) === 1,
    });
  }
  return inventory(versions);
}

function inventory(versions: readonly PluginBackupVersion[]): PluginBackupInventory {
  const hash = createHash('sha256').update(JSON.stringify(versions)).digest('hex');
  const value = { format: 1 as const, versions, hash };
  if (!validPluginBackupInventory(value)) throw Error('invalid_plugin_inventory');
  return value;
}
