/**
 * Durable owner views and resolution over the plugin operation journal.
 *
 * Reads are bounded SQL selections. The two writes are atomic: startup lowers
 * crashed `started` rows to `uncertain` (also lowering their journal claim), and
 * an owner acknowledgement compare-and-sets the visible revision while
 * releasing exactly that effect's global journal hold through the shared
 * resolution table. Neither ever retries a call or claims a remote outcome.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  PluginOperationAcknowledgeInput,
  PluginOperationFilter,
  PluginOperationStorePort,
} from '@runnets/application';
import { PluginRefusedError } from '@runnets/application';
import type { PluginOperationRecord } from '@runnets/domain';
import {
  acknowledgeOperationRow,
  lowerStartedOperations,
  readOperation,
  readOperations,
} from './plugin-operation-rows.js';
import { SqliteToolJournal } from './tool-journal.js';
import { withImmediateTransaction } from './transaction.js';

function recordContext(record: PluginOperationRecord): { taskRunId: string; attemptId: string } {
  return { taskRunId: record.taskRunId, attemptId: record.attemptId };
}

export class SqlitePluginOperations implements PluginOperationStorePort {
  readonly #db: DatabaseSync;
  readonly #journal: SqliteToolJournal;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#journal = new SqliteToolJournal(db);
  }

  list(filter: PluginOperationFilter = {}): readonly PluginOperationRecord[] {
    return readOperations(this.#db, filter);
  }

  get(operationId: string): PluginOperationRecord | null {
    return readOperation(this.#db, operationId);
  }

  /** Unknown-effect rows: they still hold every new plugin claim. */
  open(): readonly PluginOperationRecord[] {
    return [
      ...readOperations(this.#db, { state: 'started', limit: 200 }),
      ...readOperations(this.#db, { state: 'uncertain', limit: 200 }),
    ];
  }

  recoverStarted(at: string): number {
    return withImmediateTransaction(this.#db, () => {
      const lowered = lowerStartedOperations(this.#db, at);
      for (const record of lowered) this.#journal.recoverNow(record.id, recordContext(record));
      return lowered.length;
    });
  }

  acknowledge(input: PluginOperationAcknowledgeInput): PluginOperationRecord {
    return withImmediateTransaction(this.#db, () => {
      const record = acknowledgeOperationRow(this.#db, input);
      const payload = JSON.stringify({
        resolution: 'owner_acknowledged_unknown_effect',
        operationId: record.id,
        revision: record.revision,
        reason: record.acknowledgedReason,
        acknowledgedAt: record.acknowledgedAt,
      });
      try {
        // `holdNow` keeps an existing uncertain outcome; a missing/foreign claim refuses.
        this.#journal.holdNow(record.id, recordContext(record));
        this.#journal.resolveUncertainNow(record.id, recordContext(record), record.tool, payload);
      } catch {
        throw new PluginRefusedError(
          'operation_conflict',
          'plugin operation journal cannot release this hold',
        );
      }
      return record;
    });
  }
}
