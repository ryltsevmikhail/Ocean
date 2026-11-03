import { assertUnpublished } from './endpoint-proof.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openDatabase, DEFAULT_BUSY_TIMEOUT_MS } from './schema.js';
import { withImmediateTransaction } from './transaction.js';

export interface RuntimeOwner {
  readonly id: string;
  readonly pid: number;
}

/** Exclusive execution owner; PID reuse/uncertain liveness refuses takeover rather than guessing. */
export function acquireOwnership(
  db: DatabaseSync,
  owner: RuntimeOwner,
  isAlive: (pid: number) => boolean,
  requireUnpublished = true,
): () => void {
  withImmediateTransaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_owner_v1 (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner TEXT NOT NULL, pid INTEGER NOT NULL
    ) STRICT`);
    const previous = db.prepare('SELECT pid FROM runtime_owner_v1 WHERE singleton = 1').get();
    if (previous !== undefined) {
      const pid = previous['pid'];
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid))
        throw Object.assign(
          new Error('Durable runtime is owned by a live or unverified process; refusing recovery'),
          { code: 'owner_busy' },
        );
    }
    if (requireUnpublished) assertUnpublished(db);
    db.prepare(
      `INSERT INTO runtime_owner_v1 VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, pid=excluded.pid`,
    ).run(owner.id, owner.pid);
  });
  return () => {
    db.prepare('DELETE FROM runtime_owner_v1 WHERE singleton=1 AND owner=?').run(owner.id);
  };
}

/** Claim this file-backed runtime before reconciliation; OS liveness is not process-stop evidence. */
export function ownSqliteRuntime(path: string, requireUnpublished = true): () => void {
  const db = openDatabase(path, DEFAULT_BUSY_TIMEOUT_MS);
  try {
    const release = acquireOwnership(
      db,
      { id: randomUUID(), pid: process.pid },
      (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          // Permission errors and unexpected errors mean liveness cannot be disproved.
          return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
        }
      },
      requireUnpublished,
    );
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      try {
        release();
      } finally {
        db.close();
      }
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
