import { desktopInventory, readDesktopBackupInventory } from './desktop-inventory.js';
import type { DesktopAssetInventory } from '@runnets/domain';
import { assertUnpublished } from './endpoint-proof.js';
import { ownerBusy, ownerAlive as alive } from './maintenance-owner.js';
import {
  readCodingBackupInventory,
  readMaintenanceCodingInventory,
} from './coding-backup-inventory.js';
import { holdBackupObservation } from './backup-observation.js';
import type { CodingBackupInventory } from '@runnets/domain';
import { unresolvedEffectSql } from './tool-effect-resolution.js';
/** Local, non-dispatching inspection and exclusive SQLite online backup. */
import { backup, DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, chmodSync, lstatSync } from 'node:fs';
import { acquireOwnership } from './ownership.js';
import { SCHEMA_VERSION } from './schema.js';

export interface DatabaseSummary {
  readonly schema: number;
  readonly externalCodingAssets?: number;
  readonly externalDesktopAssets?: number;
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
  const desktopAssets = Number(
    count(db, "SELECT count(*) AS n FROM meta WHERE key='desktop_assets_binding'") > 0 ||
      (schema(db) >= 12 &&
        count(
          db,
          'SELECT (SELECT count(*) FROM ocean_desktop_operations)+(SELECT count(*) FROM ocean_desktop_uploads) AS n',
        ) > 0),
  );
  return {
    schema: schema(db),
    ...(schema(db) >= 7
      ? { externalCodingAssets: count(db, 'SELECT count(*) AS n FROM ocean_worktrees') }
      : {}),
    ...(schema(db) >= 12 || desktopAssets ? { externalDesktopAssets: desktopAssets } : {}),
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
      (SELECT count(*) FROM tool_invocations_v2 e WHERE ${db.prepare("SELECT 1 FROM sqlite_master WHERE name='tool_effect_resolutions_v1'").get() ? unresolvedEffectSql('e') : "e.outcome IN ('started','uncertain')"}) AS n`,
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
    db.exec('BEGIN');
    if (![5, 6, 10, 11, SCHEMA_VERSION].includes(schema(db)))
      return { status: 'unsupported_schema' };
    if (ownerBusy(db)) return { status: 'owner_busy' };
    assertUnpublished(db);
    const result = summary(db);
    db.exec('ROLLBACK');
    return { status: 'ok', summary: result };
  } catch (e) {
    if (e instanceof Error && e.message === 'endpoint_exists') throw e;
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
  return (await snapshotOwned(path, destination)).summary;
}
export interface CodingDatabaseSnapshot<T> {
  readonly summary: DatabaseSummary;
  readonly inventory: CodingBackupInventory;
  readonly assets: T;
}
export type CodingSnapshotDestination =
  | string
  | ((
      inventory: CodingBackupInventory,
      desktop: DesktopAssetInventory,
      databaseBytes: number,
    ) => string);
type SnapshotFinalizer<T> = (
  snapshot: CodingDatabaseSnapshot<T>,
  verifyFrozen: () => void,
  checkFrozenMetadata: () => void,
) => Promise<void | (() => void)>;
/** Low-level capture port. The host must verify and publish its complete asset manifest separately. */
export async function snapshotCodingDatabase<T>(
  path: string,
  destination: CodingSnapshotDestination,
  capture: (inventory: CodingBackupInventory, desktop: DesktopAssetInventory) => Promise<T>,
  finalize?: SnapshotFinalizer<T>,
): Promise<CodingDatabaseSnapshot<T>> {
  const result = await snapshotOwned(path, destination, capture, finalize);
  if (!result.inventory) throw Error('invalid_coding_inventory');
  return { summary: result.summary, inventory: result.inventory, assets: result.assets as T };
}
async function snapshotOwned<T>(
  path: string,
  selection: CodingSnapshotDestination,
  capture?: (inventory: CodingBackupInventory, desktop: DesktopAssetInventory) => Promise<T>,
  finalize?: SnapshotFinalizer<T>,
): Promise<{ summary: DatabaseSummary; inventory?: CodingBackupInventory; assets?: T }> {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('profile_missing');
  if (typeof selection === 'string' && existsSync(selection)) throw new Error('destination_exists');
  const db = new DatabaseSync(path);
  let release: (() => void) | undefined,
    frozen: ReturnType<typeof holdBackupObservation> | undefined;
  try {
    if (![5, 6, 10, 11, SCHEMA_VERSION].includes(schema(db))) throw new Error('unsupported_schema');
    if (ownerBusy(db)) throw new Error('owner_busy');
    try {
      release = acquireOwnership(db, { id: randomUUID(), pid: process.pid }, alive, true);
    } catch (e) {
      if (e instanceof Error && e.message === 'endpoint_exists') throw e;
      throw new Error('owner_busy');
    }
    const original = summary(db);
    const desktopBinding = db
      .prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'")
      .get()?.['value'];
    if (
      desktopBinding &&
      capture &&
      (JSON.parse(String(desktopBinding)) as { profileId?: string }).profileId !==
        createHash('sha256').update(dirname(path)).digest('hex')
    )
      throw Error('desktop_binding_mismatch');
    if (original.externalDesktopAssets && !capture) throw Error('desktop_assets_unavailable');
    if (
      !desktopBinding &&
      db
        .prepare(
          "SELECT 1 FROM ocean_messages WHERE author='user' AND instr(body,'[Ocean Desktop attachments v1]')>0 LIMIT 1",
        )
        .get()
    )
      throw Error('desktop_assets_unbound');
    if (original.externalCodingAssets && !capture) throw new Error('coding_assets_unavailable');
    const initial =
      typeof selection === 'function'
        ? { coding: readMaintenanceCodingInventory(db), desktop: desktopInventory(db) }
        : undefined;
    const destination =
      typeof selection === 'string'
        ? selection
        : selection(
            structuredClone(initial!.coding),
            structuredClone(initial!.desktop),
            Number(db.prepare('PRAGMA page_count').get()?.['page_count']) *
              Number(db.prepare('PRAGMA page_size').get()?.['page_size']),
          );
    if (existsSync(destination)) throw Error('destination_exists');
    await backup(db, destination);
    chmodSync(destination, 0o600);
    const snapshot = new DatabaseSync(destination);
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE; DELETE FROM runtime_owner_v1');
      const copy = summary(snapshot);
      if (JSON.stringify(original) !== JSON.stringify(copy)) throw new Error('snapshot_mismatch');
    } finally {
      snapshot.close();
    }
    if (!capture) return { summary: original };
    frozen = holdBackupObservation(destination);
    const inventory = readCodingBackupInventory(destination);
    const desktop = readDesktopBackupInventory(destination);
    if (
      initial &&
      (initial.coding.hash !== inventory.hash ||
        JSON.stringify(initial.desktop) !== JSON.stringify(desktop))
    )
      throw Error('snapshot_mismatch');
    const assets = await capture(structuredClone(inventory), desktop);
    frozen.verify();
    if (readCodingBackupInventory(destination).hash !== inventory.hash)
      throw Error('snapshot_mismatch');
    const result = { summary: original, inventory, assets };
    const publish = await finalize?.(result, frozen.verify, frozen.metadata);
    frozen.verify();
    publish?.();
    return result;
  } finally {
    frozen?.close();
    try {
      release?.();
    } finally {
      db.close();
    }
  }
}
