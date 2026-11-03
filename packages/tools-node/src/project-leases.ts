/** Cooperative per-user coordination across every updated Ocean profile/host. Not OS containment. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ok,
  codingFailure,
  projectRootsOverlap,
  validCodingFinalizationReleaseReceipt,
  type ProjectLease,
  type ProjectLeaseHolder,
  type CodingResult,
  type CodingFinalizationRegistryIdentity,
  type CodingFinalizationReleaseIntent,
  type CodingFinalizationReleaseReceipt,
} from '@runnets/domain';
import type { ProjectLeasePort, ProjectLeaseReleasePort } from '@runnets/application';
export type ProjectLeaseReleaseOutcome = ReturnType<ProjectLeaseReleasePort['releaseExact']>;
export const defaultProjectLeaseDirectory = (): string =>
  join(homedir(), '.local/state/ocean-coordination');
const RECEIPT_SCHEMA = 'project_leases_v1+project_lease_receipts_v1';
function privateFile(path: string, directory: boolean): void {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077 ||
    (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) ||
    realpathSync(path) !== resolve(path)
  )
    throw Error('Unsafe project lease registry');
}
const receiptColumns = 'operation_id,binding_digest,task_id,token_hash,holder_hash,payload';
function decodeReceipt(row: Record<string, unknown> | undefined): CodingFinalizationReleaseReceipt {
  if (!row) throw Error('registry_corrupt');
  const receipt = JSON.parse(String(row['payload'])) as CodingFinalizationReleaseReceipt;
  if (
    !validCodingFinalizationReleaseReceipt(receipt) ||
    receipt.operationId !== row['operation_id'] ||
    receipt.bindingDigest !== row['binding_digest'] ||
    receipt.taskId !== row['task_id'] ||
    receipt.tokenHash !== row['token_hash'] ||
    receipt.holderHash !== row['holder_hash']
  )
    throw Error('registry_corrupt');
  return receipt;
}
const receiptRow = (r: CodingFinalizationReleaseReceipt) => [
  r.operationId,
  r.bindingDigest,
  r.taskId,
  r.tokenHash,
  r.holderHash,
  JSON.stringify(r),
];
export class SqliteProjectLeases implements ProjectLeasePort {
  readonly #configured: string | undefined;
  constructor(directory?: string) {
    this.#configured = directory;
  }
  get #directory(): string {
    return this.#configured ?? defaultProjectLeaseDirectory();
  }
  #path(): string {
    return join(resolve(this.#directory), 'leases.sqlite');
  }
  #open(): DatabaseSync {
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    privateFile(this.#directory, true);
    const path = join(this.#directory, 'leases.sqlite');
    if (!existsSync(path)) {
      try {
        closeSync(openSync(path, 'wx', 0o600));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    }
    privateFile(path, false);
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS project_leases_v1(token TEXT PRIMARY KEY,root TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS project_lease_receipts_v1(
      operation_id TEXT PRIMARY KEY,binding_digest TEXT NOT NULL,task_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,holder_hash TEXT NOT NULL,payload TEXT NOT NULL
    ) STRICT;`);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  identity(): CodingFinalizationRegistryIdentity {
    return { path: this.#path(), schema: RECEIPT_SCHEMA };
  }
  #all(db: DatabaseSync): ProjectLease[] {
    return db
      .prepare('SELECT * FROM project_leases_v1')
      .all()
      .map((row) => {
        const lease = JSON.parse(String(row['payload'])) as ProjectLease;
        if (lease.token !== row['token'] || lease.projectRoot !== row['root'])
          throw Error('Invalid project lease');
        return lease;
      });
  }
  #exact(current: ProjectLease, lease: ProjectLease): boolean {
    return (
      current.token === lease.token &&
      current.projectRoot === lease.projectRoot &&
      current.ownerId === lease.ownerId &&
      current.taskId === lease.taskId &&
      current.requestId === lease.requestId &&
      current.binding === lease.binding &&
      current.kind === lease.kind
    );
  }
  /** A missing registry is never created as part of a release. */
  #existing(): DatabaseSync | null {
    if (!existsSync(this.#directory) || !existsSync(this.#path())) return null;
    try {
      privateFile(this.#directory, true);
      privateFile(this.#path(), false);
      return new DatabaseSync(this.#path());
    } catch {
      throw Error('registry_corrupt');
    }
  }
  releaseExact(
    lease: ProjectLease,
    intent: CodingFinalizationReleaseIntent,
  ): ProjectLeaseReleaseOutcome {
    let db: DatabaseSync | null;
    try {
      db = this.#existing();
    } catch {
      return { outcome: 'registry_corrupt', detail: 'unsafe_registry' };
    }
    if (!db) return { outcome: 'registry_missing', detail: 'registry_absent' };
    try {
      db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS project_lease_receipts_v1(
        operation_id TEXT PRIMARY KEY,binding_digest TEXT NOT NULL,task_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,holder_hash TEXT NOT NULL,payload TEXT NOT NULL
      ) STRICT;`);
      db.exec('BEGIN IMMEDIATE');
      const existing = db
        .prepare(
          'SELECT ' + receiptColumns + ' FROM project_lease_receipts_v1 WHERE operation_id=?',
        )
        .get(intent.operationId);
      if (existing) {
        const receipt = decodeReceipt(existing);
        db.exec('ROLLBACK');
        return receipt.bindingDigest === intent.bindingDigest &&
          receipt.tokenHash === intent.tokenHash &&
          receipt.holderHash === intent.holderHash &&
          receipt.taskId === intent.taskId
          ? { outcome: 'released', receipt }
          : { outcome: 'receipt_conflict', detail: 'operation_receipt_mismatch' };
      }
      const current = this.#all(db).find((entry) => entry.token === lease.token);
      if (!current) {
        db.exec('ROLLBACK');
        return { outcome: 'absent' };
      }
      if (!this.#exact(current, lease)) {
        db.exec('ROLLBACK');
        return { outcome: 'mismatch', detail: 'holder_changed' };
      }
      const receipt: CodingFinalizationReleaseReceipt = {
        version: 1,
        ...intent,
        registry: this.identity(),
      };
      if (!validCodingFinalizationReleaseReceipt(receipt)) throw Error('invalid_receipt');
      db.prepare('DELETE FROM project_leases_v1 WHERE token=?').run(lease.token);
      db.prepare('INSERT INTO project_lease_receipts_v1 VALUES(?,?,?,?,?,?)').run(
        ...receiptRow(receipt),
      );
      db.exec('COMMIT');
      return { outcome: 'released', receipt };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      return {
        outcome: 'registry_corrupt',
        detail: error instanceof Error ? error.message : 'registry_failure',
      };
    } finally {
      if (db.isOpen) db.close();
    }
  }
  releaseReceipt(operationId: string): CodingFinalizationReleaseReceipt | null {
    let db: DatabaseSync | null;
    try {
      db = this.#existing();
    } catch {
      throw Error('registry_corrupt');
    }
    if (!db) return null;
    try {
      if (
        !db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_lease_receipts_v1'",
          )
          .get()
      )
        return null;
      const row = db
        .prepare(
          'SELECT ' + receiptColumns + ' FROM project_lease_receipts_v1 WHERE operation_id=?',
        )
        .get(operationId);
      return row ? decodeReceipt(row) : null;
    } finally {
      if (db.isOpen) db.close();
    }
  }
  acquire(projectRoot: string, holder: ProjectLeaseHolder): CodingResult<ProjectLease> {
    if (
      (projectRoot === '*' && holder.kind !== 'legacy-command') ||
      (projectRoot !== '*' &&
        (!projectRoot.startsWith('/') || resolve(projectRoot) !== projectRoot))
    )
      return codingFailure('invalid_input');
    const db = this.#open();
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const lease of this.#all(db)) {
        if (
          lease.projectRoot === projectRoot &&
          lease.ownerId === holder.ownerId &&
          lease.taskId === holder.taskId &&
          lease.requestId === holder.requestId &&
          lease.binding === holder.binding &&
          lease.kind === holder.kind
        ) {
          db.exec('COMMIT');
          return ok(lease);
        }
        if (projectRootsOverlap(projectRoot, lease.projectRoot)) {
          db.exec('ROLLBACK');
          return codingFailure('project_busy');
        }
      }
      const lease = { ...holder, projectRoot, token: randomUUID() };
      db.prepare('INSERT INTO project_leases_v1 VALUES(?,?,?)').run(
        lease.token,
        projectRoot,
        JSON.stringify(lease),
      );
      db.exec('COMMIT');
      return ok(lease);
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
    }
  }
  owns(lease: ProjectLease): boolean {
    const db = this.#open();
    try {
      return this.#all(db).some(
        (l) => l.token === lease.token && JSON.stringify(l) === JSON.stringify(lease),
      );
    } finally {
      db.close();
    }
  }
  release(lease: ProjectLease): boolean {
    const db = this.#open();
    try {
      db.exec('BEGIN IMMEDIATE');
      const current = this.#all(db).find((l) => l.token === lease.token);
      if (current && JSON.stringify(current) !== JSON.stringify(lease)) {
        db.exec('ROLLBACK');
        return false;
      }
      db.prepare('DELETE FROM project_leases_v1 WHERE token=?').run(lease.token);
      db.exec('COMMIT');
      return true;
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
    }
  }
}
