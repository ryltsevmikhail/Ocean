/**
 * Durable command idempotency store.
 *
 * Receipts are keyed by command id and written inside an immediate transaction.
 * A repeated `put` never replaces an existing receipt: the first committed
 * receipt is the one replayed, so a retried submission cannot rewrite command
 * history. Receipt events round-trip through JSON as committed envelopes.
 */

import type { CommandDedupPort, CommandReceipt } from '@runnets/application';
import type { TaskRunEvent } from '@runnets/domain';
import { taskRunId as parseTaskRunId } from '@runnets/domain';
import type { DatabaseSync } from 'node:sqlite';

import { freezeCopy } from './freeze.js';
import { toPromise } from './promise.js';
import { readInteger, readText, type SqliteRow } from './rows.js';
import { withImmediateTransaction } from './transaction.js';

const INSERT_RECEIPT_SQL = `INSERT INTO command_receipts (command_id, aggregate_id, version, events)
VALUES (?, ?, ?, ?)
ON CONFLICT (command_id) DO NOTHING`;

const SELECT_RECEIPT_SQL =
  'SELECT command_id, aggregate_id, version, events FROM command_receipts WHERE command_id = ?';

export class SqliteCommandDedup implements CommandDedupPort {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** The receipt committed for a command id, if any. */
  get(commandId: string): Promise<CommandReceipt | null> {
    return toPromise(() => this.read(commandId));
  }

  /** Store the first receipt for a command id; a later put is a no-op. */
  put(receipt: CommandReceipt): Promise<void> {
    return toPromise(() => this.#put(receipt));
  }

  /** Read a receipt within an existing synchronous transaction. */
  read(commandId: string): CommandReceipt | null {
    const row = this.#db.prepare(SELECT_RECEIPT_SQL).get(commandId);
    if (row === undefined) return null;
    return readReceipt(row);
  }

  #put(receipt: CommandReceipt): void {
    withImmediateTransaction(this.#db, () => this.write(receipt));
  }

  /** Insert the immutable receipt within the caller's transaction. */
  write(receipt: CommandReceipt): void {
    this.#db
      .prepare(INSERT_RECEIPT_SQL)
      .run(receipt.commandId, receipt.taskRunId, receipt.version, JSON.stringify(receipt.events));
  }
}

function readReceipt(row: SqliteRow): CommandReceipt {
  return Object.freeze({
    commandId: readText(row, 'command_id'),
    taskRunId: parseTaskRunId(readText(row, 'aggregate_id')),
    version: readInteger(row, 'version'),
    events: parseEvents(readText(row, 'events')),
  });
}

function parseEvents(json: string): readonly TaskRunEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new Error('stored command receipt events are not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('stored command receipt events must be an array');
  }
  return Object.freeze(freezeCopy(parsed) as readonly TaskRunEvent[]);
}
