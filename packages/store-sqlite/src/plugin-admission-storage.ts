/**
 * Durable plugin admission adapter.
 *
 * The same immediate transaction re-reads the authority snapshot and claims the
 * journal invocation through `SqliteToolJournal.claimNow`, so a grant/connection
 * race can never reach the transport with stale permission. Settlement uses the
 * existing journal and never re-authorizes a dispatch.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  PluginAdmissionStorePort,
  PluginAdmissionTransaction,
  ToolEffectContext,
} from '@runnets/application';
import { isMember, readConnection, readEnabled, readGrant } from './plugin-reads.js';
import { withImmediateTransaction } from './transaction.js';
import { SqliteToolJournal } from './tool-journal.js';

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
}
