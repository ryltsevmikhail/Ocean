/**
 * Durable plugin admission adapter.
 *
 * The same immediate transaction re-reads the authority snapshot, claims the
 * journal invocation through `SqliteToolJournal.claimNow` and inserts the
 * durable operation row, so a grant/connection race can never reach the
 * transport with stale permission. Settlement updates the operation row and the
 * journal in one transaction and never re-authorizes a dispatch.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  PluginAdmissionSettlement,
  PluginAdmissionStorePort,
  PluginAdmissionTransaction,
  ToolEffectContext,
} from '@runnets/application';
import { insertOperation } from './plugin-operation-rows.js';
import { isMember, readConnection, readEnabled, readGrant } from './plugin-reads.js';
import { withImmediateTransaction } from './transaction.js';
import { SqliteToolJournal } from './tool-journal.js';
import { settleOperationRow } from './plugin-operation-rows.js';

export class SqlitePluginAdmission implements PluginAdmissionStorePort {
  readonly #db: DatabaseSync;
  readonly #journal: SqliteToolJournal;
  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#journal = new SqliteToolJournal(db);
  }
  atomic<T>(work: (tx: PluginAdmissionTransaction) => T): T {
    const db = this.#db;
    return withImmediateTransaction(db, () =>
      work({
        member: (workspaceId, roomId, botId) => isMember(db, workspaceId, roomId, botId),
        connection: (id) => readConnection(db, id),
        grant: (id) => readGrant(db, id),
        enabledVersion: (pluginId) => readEnabled(db, pluginId),
        claim: (id, tool, context, fingerprint) =>
          this.#journal.claimNow(id, tool, context, fingerprint),
        beginOperation: (record) => insertOperation(db, record),
      }),
    );
  }
  settle(
    id: string,
    outcome: 'completed' | 'failed' | 'uncertain' | 'not_started',
    context: ToolEffectContext,
  ): void {
    this.#journal.settleNow(id, outcome, context);
  }
  settleOperation(
    id: string,
    settlement: PluginAdmissionSettlement,
    journalOutcome: 'completed' | 'failed' | 'uncertain' | 'not_started',
    context: ToolEffectContext,
  ): void {
    withImmediateTransaction(this.#db, () => {
      settleOperationRow(this.#db, id, settlement);
      this.#journal.settleNow(id, journalOutcome, context);
    });
  }
}
