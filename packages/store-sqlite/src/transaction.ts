/**
 * Write transaction helper.
 *
 * The immediate transaction takes the write lock up front, so the
 * expected-version read and the conditional append cannot be interleaved by a
 * competing writer. Any thrown error rolls the whole batch back; a caller that
 * commits means SQLite durably committed.
 */

import type { DatabaseSync } from 'node:sqlite';

/** Run `work` inside `BEGIN IMMEDIATE` and commit only if it completes. */
export function withImmediateTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
