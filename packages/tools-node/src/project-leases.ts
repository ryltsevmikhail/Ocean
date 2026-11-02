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
  type ProjectLease,
  type ProjectLeaseHolder,
  type CodingResult,
} from '@runnets/domain';
import type { ProjectLeasePort } from '@runnets/application';
export const defaultProjectLeaseDirectory = (): string =>
  join(homedir(), '.local/state/ocean-coordination');
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
export class SqliteProjectLeases implements ProjectLeasePort {
  readonly #directory: string;
  constructor(directory = defaultProjectLeaseDirectory()) {
    this.#directory = directory;
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
    CREATE TABLE IF NOT EXISTS project_leases_v1(token TEXT PRIMARY KEY,root TEXT NOT NULL,payload TEXT NOT NULL) STRICT;`);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
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
