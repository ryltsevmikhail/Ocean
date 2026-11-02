/**
 * @runnets/store-sqlite — durable SQLite adapters.
 *
 * The package implements the application event-log and command-dedup ports over
 * `node:sqlite`, plus a checkpoint store and a recovery helper that rebuilds
 * aggregate state from the latest checkpoint and the events after it. The public
 * surface is re-exported here.
 */

export { openSqliteStore } from './store.js';
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
