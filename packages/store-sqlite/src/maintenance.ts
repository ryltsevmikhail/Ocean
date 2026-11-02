/** Local, non-dispatching inspection and exclusive SQLite online backup. */
import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, chmodSync, lstatSync } from 'node:fs';
import { acquireOwnership } from './ownership.js';
import { SCHEMA_VERSION } from './schema.js';

export interface DatabaseSummary {
  readonly schema: number;
  readonly externalCodingAssets?: number;
  readonly rooms: number;
  readonly messages: number;
  readonly positions: readonly { roomId: string; sequence: number }[];
  readonly pendingEffects: number;
  readonly unfinishedRuns: number;
  readonly heldRooms: number;
}
export type DatabaseInspection =
  | { readonly status: 'ok'; readonly summary: DatabaseSummary }
  | { readonly status: 'owner_busy' | 'unsupported_schema' | 'invalid_database' };
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
function ownerBusy(db: DatabaseSync): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_owner_v1'").get()) return false;
  const owner = db.prepare('SELECT pid FROM runtime_owner_v1 WHERE singleton=1').get();
  if (!owner) return false;
  return typeof owner['pid'] !== 'number' || owner['pid'] <= 0 || alive(owner['pid']);
}
function schema(db: DatabaseSync): number {
  return Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']);
}
function count(db: DatabaseSync, query: string): number {
  return Number(db.prepare(query).get()?.['n']);
}
function verify(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (
    rows.length !== 1 ||
    rows[0]?.['integrity_check'] !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length !== 0
  )
    throw new Error('invalid_database');
}
function summary(db: DatabaseSync): DatabaseSummary {
  verify(db);
  return {
    schema: schema(db),
    ...(schema(db) >= 7
      ? { externalCodingAssets: count(db, 'SELECT count(*) AS n FROM ocean_worktrees') }
      : {}),
    rooms: count(db, 'SELECT count(*) AS n FROM ocean_rooms'),
    messages: count(db, 'SELECT count(*) AS n FROM ocean_messages'),
    positions: db
      .prepare(
        `SELECT r.id, coalesce(max(m.seq),0) AS seq
      FROM ocean_rooms r LEFT JOIN ocean_messages m ON m.room_id=r.id GROUP BY r.id ORDER BY r.id`,
      )
      .all()
      .map((r) => ({ roomId: String(r['id']), sequence: Number(r['seq']) })),
    pendingEffects: count(
      db,
      `SELECT
      (SELECT count(*) FROM tool_invocations_v1 WHERE outcome IN ('started','uncertain')) +
      (SELECT count(*) FROM tool_invocations_v2 WHERE outcome IN ('started','uncertain')) AS n`,
    ),
    unfinishedRuns: count(
      db,
      `SELECT count(*) AS n FROM events e
      WHERE e.aggregate_type='task_run' AND e.sequence=(SELECT max(sequence) FROM events WHERE aggregate_id=e.aggregate_id)
      AND e.type NOT IN ('task_run.succeeded','task_run.failed','task_run.cancelled')`,
    ),
    heldRooms: count(
      db,
      `SELECT count(*) AS n FROM ocean_chat_turns
      WHERE status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL`,
    ),
  };
}
/** Never migrates, reconciles, dispatches or steals a live owner's profile. */
export function inspectDatabase(path: string): DatabaseInspection {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (![5, 6, SCHEMA_VERSION].includes(schema(db))) return { status: 'unsupported_schema' };
    if (ownerBusy(db)) return { status: 'owner_busy' };
    db.exec('BEGIN');
    const result = summary(db);
    db.exec('ROLLBACK');
    return { status: 'ok', summary: result };
  } catch {
    return { status: 'invalid_database' };
  } finally {
    db?.close();
  }
}
/** Caller supplies a new private destination, never an existing file. */
export async function snapshotDatabase(
  path: string,
  destination: string,
): Promise<DatabaseSummary> {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('profile_missing');
  if (existsSync(destination)) throw new Error('destination_exists');
  const db = new DatabaseSync(path);
  let release: (() => void) | undefined;
  try {
    if (![5, 6, SCHEMA_VERSION].includes(schema(db))) throw new Error('unsupported_schema');
    if (ownerBusy(db)) throw new Error('owner_busy');
    try {
      release = acquireOwnership(db, { id: randomUUID(), pid: process.pid }, alive);
    } catch {
      throw new Error('owner_busy');
    }
    const original = summary(db);
    if (original.externalCodingAssets) throw new Error('coding_assets_unavailable');
    await backup(db, destination);
    chmodSync(destination, 0o600);
    const snapshot = new DatabaseSync(destination);
    try {
      snapshot.exec('DELETE FROM runtime_owner_v1');
      const copy = summary(snapshot);
      if (JSON.stringify(original) !== JSON.stringify(copy)) throw new Error('snapshot_mismatch');
    } finally {
      snapshot.close();
    }
    return original;
  } finally {
    try {
      release?.();
    } finally {
      db.close();
    }
  }
}
