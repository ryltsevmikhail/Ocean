/**
 * Default identity source for the durable adapters.
 *
 * Counters are allocated under the database write lock and survive restarts.
 * Existing stores initialize them from row ids and skip persisted identities. A host-supplied
 * `IdGenerator` remains responsible for its own identity uniqueness.
 */

import type { IdGenerator } from '@runnets/application';
import { isValidId } from '@runnets/domain';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from './transaction.js';

const COUNTER_DIGITS = 4;

/** Mint ids whose persisted counters never go backwards across restarts. */
export function createDurableIdGenerator(db: DatabaseSync): IdGenerator {
  function next(kind: 'ev' | 'cm', table: 'events' | 'command_receipts'): string {
    const allocate = (): string => {
      const key = `identity_counter_${kind}`;
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(
        key,
        String(highestRowId(db, table)),
      );
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      const value = row?.['value'];
      if (typeof value !== 'string' || !/^\d+$/.test(value))
        throw new Error('invalid identity counter');
      let nextValue = Number(value);
      let id: string;
      const column = kind === 'ev' ? 'event_id' : 'command_id';
      const exists = db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`);
      do {
        nextValue += 1;
        if (!Number.isSafeInteger(nextValue)) throw new RangeError('identity counter exhausted');
        id = format(kind, nextValue);
      } while (exists.get(id) !== undefined);
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(nextValue), key);
      return id;
    };
    // Event allocation shares the enclosing append transaction; standalone command
    // allocation takes its own lock so separate connections never reuse identities.
    return db.isTransaction ? allocate() : withImmediateTransaction(db, allocate);
  }
  return {
    eventId: () => next('ev', 'events'),
    commandId: () => next('cm', 'command_receipts'),
  };
}

function highestRowId(db: DatabaseSync, table: 'events' | 'command_receipts'): number {
  // The row id is monotonic for an append-only table, which is exactly the
  // number of ids this generator already minted for that table.
  const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS maximum FROM ${table}`).get();
  if (row === undefined) throw new Error(`SQLite returned no row for ${table} row ids`);
  const maximum = row['maximum'];
  if (typeof maximum !== 'number' || !Number.isInteger(maximum) || maximum < 0) {
    throw new Error(`SQLite returned an invalid ${table} row id`);
  }
  return maximum;
}

function format(kind: 'ev' | 'cm', sequence: number): string {
  const raw = `${kind}_${String(sequence).padStart(COUNTER_DIGITS, '0')}`;
  if (!isValidId(raw, kind)) {
    throw new RangeError(`generated id violates the domain id contract: ${raw}`);
  }
  return raw;
}
