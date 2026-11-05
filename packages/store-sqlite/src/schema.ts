/**
 * Database profile and schema.
 *
 * Durability is a property of the connection: WAL journaling, `synchronous =
 * FULL`, foreign keys for checkpoint integrity and a bounded lock wait. The
 * schema version lives in a `meta` row; an unknown or newer database fails
 * closed instead of being written with a schema this adapter does not own.
 */

import { DatabaseSync } from 'node:sqlite';

import { assertMigrationOwnerAbsent } from './conversation-schema.js';

import { readText } from './rows.js';
import { applyMigrations } from './schema-migrations.js';

import { ownerBusy } from './maintenance-owner.js';
import { userTables } from './schema-inspection.js';
/** Schema 25 adds optional admission evidence to the existing effect journal. */
export const SCHEMA_VERSION = 25;
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
export const MAX_BUSY_TIMEOUT_MS = 60_000;

const REQUIRED_TABLES = ['events', 'command_receipts', 'checkpoints', 'meta'] as const;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (aggregate_id, sequence),
  CHECK (sequence >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  events TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS checkpoints (
  aggregate_id TEXT NOT NULL,
  event_position INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  snapshot TEXT,
  PRIMARY KEY (aggregate_id, event_position),
  CHECK (event_position >= 1),
  FOREIGN KEY (aggregate_id, event_position) REFERENCES events (aggregate_id, sequence)
) STRICT;
`;

/** Validate the bounded lock wait before touching a database. */
export function assertBusyTimeout(busyTimeoutMs: number): void {
  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
  ) {
    throw new RangeError(
      `busy timeout must be an integer between 0 and ${MAX_BUSY_TIMEOUT_MS}, received ${busyTimeoutMs}`,
    );
  }
}

/**
 * Open a configured database.
 *
 * The connection is closed again when the profile or the schema check fails, so
 * a caller never receives a half-initialized handle.
 */
export function openDatabase(
  path: string,
  busyTimeoutMs: number,
  requireOwnerAbsent = false,
): DatabaseSync {
  assertBusyTimeout(busyTimeoutMs);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = ' + String(busyTimeoutMs));
    initializeSchema(db, requireOwnerAbsent);
    applyDurabilityProfile(db, busyTimeoutMs);
    if (path !== ':memory:') assertWalMode(db);
    return db;
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

/** Apply the durability profile and verify that SQLite accepted it. */
export function applyDurabilityProfile(db: DatabaseSync, busyTimeoutMs: number): void {
  assertBusyTimeout(busyTimeoutMs);
  // WAL is the only journal mode that keeps a file-backed store durable without
  // rewriting the whole database; in-memory databases report `memory` instead.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  assertPragma(db, 'synchronous', 'synchronous', 2);
  assertPragma(db, 'foreign_keys', 'foreign_keys', 1);
  assertPragma(db, 'busy_timeout', 'timeout', busyTimeoutMs);
}

/**
 * Create the schema for a fresh database, or verify an existing one.
 *
 * An existing database must carry the supported schema version and every table;
 * anything else is refused rather than silently overwritten.
 */
export function initializeSchema(db: DatabaseSync, requireOwnerAbsent = false): void {
  if (db.isTransaction) throw new Error('Schema initialization requires its own transaction');
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'] === 1;
  // Parent-table replacement is isolated in one transaction and checked before commit.
  if (foreignKeys) db.exec('PRAGMA foreign_keys=OFF');
  try {
    initializeSchemaTransaction(db, requireOwnerAbsent);
  } finally {
    if (foreignKeys) db.exec('PRAGMA foreign_keys=ON');
  }
}
function initializeSchemaTransaction(db: DatabaseSync, requireOwnerAbsent: boolean): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Prospective execution ownership is checked inside the schema transaction before writes.
    if (requireOwnerAbsent && ownerBusy(db))
      throw Object.assign(
        Error('Durable runtime is owned by a live or unverified process; refusing recovery'),
        { code: 'owner_busy' },
      );
    const existing = userTables(db);
    let previousVersion = 1;
    if (!existing.has('meta')) {
      if (existing.size > 0) {
        throw new Error(
          `database is not a RunneTS store: found tables without a schema version: ${[...existing].join(', ')}`,
        );
      }
      db.exec(DDL);
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
        String(SCHEMA_VERSION),
      );
    } else {
      previousVersion = assertSchemaVersion(db);
      for (const table of REQUIRED_TABLES) {
        if (!existing.has(table)) {
          throw new Error(`database schema is missing table ${table}`);
        }
      }
    }
    if (previousVersion < SCHEMA_VERSION) assertMigrationOwnerAbsent(db);
    // Additive v1 extension preserves old stores and marks old receipts as unbound.
    const receiptColumns = db.prepare('PRAGMA table_info(command_receipts)').all();
    if (!receiptColumns.some((column) => column['name'] === 'request_binding')) {
      db.exec('ALTER TABLE command_receipts ADD COLUMN request_binding TEXT');
    }
    applyMigrations(db, previousVersion, existing);
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0)
      throw new Error('Schema foreign key check failed');
    db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function assertWalMode(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA journal_mode').get();
  if (row === undefined || row['journal_mode'] !== 'wal') {
    throw new Error('SQLite journal_mode is not "wal" for a file-backed store');
  }
}

function assertPragma(
  db: DatabaseSync,
  statement: string,
  column: string,
  expected: number | string,
): void {
  const row = db.prepare(`PRAGMA ${statement}`).get();
  if (row === undefined || row[column] !== expected) {
    throw new Error(`SQLite PRAGMA ${statement} is not ${expected}`);
  }
}

function assertSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  if (row === undefined) {
    throw new Error('database is not a RunneTS store: meta has no schema_version row');
  }
  const raw = readText(row, 'value');
  if (!/^\d+$/.test(raw)) {
    throw new Error(`database schema version is not an integer: ${raw}`);
  }
  const version = Number.parseInt(raw, 10);
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is newer than the supported version ${SCHEMA_VERSION}`,
    );
  }
  if (version < 1) {
    throw new Error(
      `database schema version ${version} is older than the supported version ${SCHEMA_VERSION} and no migration exists`,
    );
  }
  return version;
}
