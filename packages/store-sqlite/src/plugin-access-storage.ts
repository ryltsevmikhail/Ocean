/**
 * Durable plugin access-grant adapter.
 *
 * `atomic` runs one immediate transaction so room membership, the enabled
 * version, the connection generation and grant creation share a single
 * authority snapshot. Revoke is a one-way durable state change.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  PluginAccessStorePort,
  PluginAccessTransaction,
  PluginConnectionRecord,
  PluginGrantScopeFacts,
  PluginInstalledVersion,
} from '@runnets/application';
import type { PluginGrantRecord } from '@runnets/domain';
import {
  activeGrants,
  grantRow,
  isMember,
  readConnection,
  readEnabled,
  readGrant,
  roomFacts,
} from './plugin-reads.js';
import { withImmediateTransaction } from './transaction.js';

export class SqlitePluginAccess implements PluginAccessStorePort {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  atomic<T>(work: (tx: PluginAccessTransaction) => T): T {
    return withImmediateTransaction(this.#db, () => work(this.#transaction()));
  }
  grants(
    filter: {
      readonly workspaceId?: string;
      readonly roomId?: string;
      readonly botId?: string;
      readonly pluginId?: string;
    } = {},
  ): readonly PluginGrantRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [column, value] of [
      ['workspace_id', filter.workspaceId],
      ['room_id', filter.roomId],
      ['bot_id', filter.botId],
      ['plugin_id', filter.pluginId],
    ] as const) {
      if (value === undefined) continue;
      clauses.push(column + ' = ?');
      values.push(value);
    }
    const where = clauses.length === 0 ? '' : ' WHERE ' + clauses.join(' AND ');
    return this.#db
      .prepare('SELECT * FROM ocean_plugin_grants' + where + ' ORDER BY created_at, id')
      .all(...values)
      .map((row) => grantRow(row))
      .filter((grant): grant is PluginGrantRecord => grant !== null);
  }
  revoke(grantId: string, at: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE ocean_plugin_grants SET state = 'revoked', revoked_at = ?
         WHERE id = ? AND state = 'active'`,
      )
      .run(at, grantId);
    return result.changes === 1;
  }
  /** Test seam reserved for Task 6 confirmations; no product path creates them in RC2. */
  seedPendingConfirmation(id: string, connectionId: string, generation: number, at: string): void {
    this.#db
      .prepare(
        `INSERT INTO ocean_plugin_confirmations
         (id, connection_id, connection_generation, state, created_at, revoked_at)
         VALUES (?,?,?,'pending',?,NULL)`,
      )
      .run(id, connectionId, generation, at);
  }
  pendingConfirmations(): readonly {
    readonly id: string;
    readonly state: 'pending' | 'revoked' | 'consumed';
  }[] {
    return this.#db
      .prepare('SELECT id, state FROM ocean_plugin_confirmations ORDER BY id')
      .all()
      .map((row) => ({
        id: String(row['id']),
        state: String(row['state']) as 'pending' | 'revoked' | 'consumed',
      }));
  }
  #transaction(): PluginAccessTransaction {
    const db = this.#db;
    return {
      member: (workspaceId, roomId, botId) => isMember(db, workspaceId, roomId, botId),
      room: (roomId) => roomFacts(db, roomId),
      connection: (id): PluginConnectionRecord | null => readConnection(db, id),
      enabledVersion: (pluginId): PluginInstalledVersion | null => readEnabled(db, pluginId),
      activeGrants: (scope: PluginGrantScopeFacts) => activeGrants(db, scope),
      grant: (id) => readGrant(db, id),
      putGrant: (record) => {
        db.prepare(
          `INSERT INTO ocean_plugin_grants
           (id, workspace_id, room_id, bot_id, plugin_id, connection_id, connection_generation,
            tools, repository, schema_digest, policy_version, visibility, state, created_at, revoked_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        ).run(
          record.id,
          record.workspaceId,
          record.roomId,
          record.botId,
          record.pluginId,
          record.connectionId,
          record.connectionGeneration,
          JSON.stringify(record.tools),
          record.repository,
          record.schemaDigest,
          record.policyVersion,
          record.visibility,
          record.state,
          record.createdAt,
        );
      },
      putGrantAndRevokePrevious: (record, at) => {
        db.prepare(
          `UPDATE ocean_plugin_grants SET state = 'revoked', revoked_at = ?
           WHERE state = 'active' AND workspace_id = ? AND room_id = ? AND bot_id = ?
             AND plugin_id = ?`,
        ).run(at, record.workspaceId, record.roomId, record.botId, record.pluginId);
        db.prepare(
          `INSERT INTO ocean_plugin_grants
           (id, workspace_id, room_id, bot_id, plugin_id, connection_id, connection_generation,
            tools, repository, schema_digest, policy_version, visibility, state, created_at, revoked_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        ).run(
          record.id,
          record.workspaceId,
          record.roomId,
          record.botId,
          record.pluginId,
          record.connectionId,
          record.connectionGeneration,
          JSON.stringify(record.tools),
          record.repository,
          record.schemaDigest,
          record.policyVersion,
          record.visibility,
          record.state,
          record.createdAt,
        );
      },
    };
  }
}
