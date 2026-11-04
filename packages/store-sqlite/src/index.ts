/**
 * @runnets/store-sqlite — durable SQLite adapters.
 *
 * The package implements the application event-log and command-dedup ports over
 * `node:sqlite`, plus a checkpoint store and a recovery helper that rebuilds
 * aggregate state from the latest checkpoint and the events after it. The public
 * surface is re-exported here.
 */

export { openSqliteStore } from './store.js';
export { SCHEMA_VERSION } from './schema.js';
export type { OpenSqliteStoreOptions, SqliteStore } from './store.js';
export type { Checkpoint, CheckpointStore } from './checkpoints.js';
export type { RecoveryResult } from './recovery.js';
export { ownSqliteRuntime } from './ownership.js';

export { inspectDatabase, snapshotDatabase } from './maintenance.js';
export type { DatabaseSummary, DatabaseInspection } from './maintenance.js';

export { SqliteCodingApprovalStore } from './coding-approval-storage.js';
export { readCodingBackupInventory } from './coding-backup-inventory.js';
export { snapshotCodingDatabase } from './maintenance.js';
export type { CodingDatabaseSnapshot } from './maintenance.js';
export type { EndpointProof } from './endpoint-proof.js';
export type { ProfileReads } from './profile-reads.js';
export { readDesktopBackupInventory } from './desktop-inventory.js';
export { readProfileRestoreSnapshot } from './restore-snapshot.js';
export { readRestorationAuthority } from './restoration-authority.js';
export { readRestorationBackupState } from './restoration-backup.js';
export { finalizationStore } from './coding-finalization-store.js';
export { projectFinalizationHeld } from './coding-finalization-holds.js';
export { SqliteProviderConnections } from './provider-connection-storage.js';
export {
  PROVIDER_CONNECTION_TABLES,
  migrateProviderConnections,
} from './provider-connection-schema.js';
export { BROADCAST_TABLES, migrateBroadcasts } from './broadcast-schema.js';

export { SqlitePluginCatalog } from './plugin-catalog-storage.js';
export { SqlitePluginConnections } from './plugin-connection-storage.js';
export { SqlitePluginAccess } from './plugin-access-storage.js';
export { SqlitePluginAdmission } from './plugin-admission-storage.js';
export { PLUGIN_TABLES, migratePlugins } from './plugin-schema.js';
export {
  readPluginBackupInventory,
  readMaintenancePluginInventory,
} from './plugin-backup-inventory.js';
