/**
 * Durable plugin connection adapter.
 *
 * Authority-bearing changes (account, endpoint, credential reference, schema
 * digest, plugin version, adapter build) increment the generation and revoke
 * grants plus pending confirmations in the same immediate transaction. A
 * schema digest is written only by `publishDiscovery`, whose caller has already
 * observed one complete transport catalog.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  PluginConnectionPatch,
  PluginConnectionRecord,
  PluginConnectionStorePort,
  PluginDiscoveryConsentRecord,
  PluginDiscoveryPublication,
  PluginDiscoveryPublicationResult,
} from '@runnets/application';
import {
  connectionRow,
  deleteConsents,
  readConnection,
  revokeConfirmationsForConnection,
  revokeGrantsForConnection,
} from './plugin-reads.js';
import { withImmediateTransaction } from './transaction.js';

export class SqlitePluginConnections implements PluginConnectionStorePort {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  list(): readonly PluginConnectionRecord[] {
    return this.#db
      .prepare('SELECT * FROM ocean_plugin_connections ORDER BY created_at, id')
      .all()
      .map((row) => connectionRow(row))
      .filter((row): row is PluginConnectionRecord => row !== null);
  }
  get(id: string): PluginConnectionRecord | null {
    return readConnection(this.#db, id);
  }
  add(record: PluginConnectionRecord): void {
    try {
      this.#db
        .prepare(
          `INSERT INTO ocean_plugin_connections
           (id, name, plugin_id, plugin_version, adapter_version, endpoint, credential_ref,
            account_label, identity, identity_verified, state, generation, schema_digest, tools,
            consented_generation, consented_at, last_discovery_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)`,
        )
        .run(
          record.id,
          record.name,
          record.pluginId,
          record.pluginVersion,
          record.adapterVersion,
          record.endpoint,
          record.credentialReference,
          record.accountLabel,
          record.identity,
          record.identityVerified ? 1 : 0,
          record.state,
          record.generation,
          record.createdAt,
          record.updatedAt,
        );
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE'))
        throw Error('connection_exists');
      throw error;
    }
  }
  change(
    connectionId: string,
    expectedGeneration: number,
    patch: PluginConnectionPatch,
    at: string,
  ): PluginConnectionRecord {
    return withImmediateTransaction(this.#db, () => {
      const current = readConnection(this.#db, connectionId);
      if (current === null) throw Error('connection_unknown');
      if (current.generation !== expectedGeneration) throw Error('connection_changed');
      this.#db
        .prepare(
          `UPDATE ocean_plugin_connections SET
           endpoint = coalesce(?, endpoint),
           credential_ref = coalesce(?, credential_ref),
           account_label = CASE WHEN ? THEN ? ELSE account_label END,
           plugin_version = coalesce(?, plugin_version),
           adapter_version = coalesce(?, adapter_version),
           generation = generation + 1,
           updated_at = ?
           WHERE id = ?`,
        )
        .run(
          patch.endpoint ?? null,
          patch.credentialReference ?? null,
          patch.accountLabel === undefined ? 0 : 1,
          patch.accountLabel ?? null,
          patch.pluginVersion ?? null,
          patch.adapterVersion ?? null,
          at,
          connectionId,
        );
      revokeGrantsForConnection(this.#db, connectionId, at);
      revokeConfirmationsForConnection(this.#db, connectionId, at);
      deleteConsents(this.#db, connectionId);
      return readConnection(this.#db, connectionId)!;
    });
  }
  consent(record: PluginDiscoveryConsentRecord): void {
    withImmediateTransaction(this.#db, () => {
      const current = readConnection(this.#db, record.connectionId);
      if (current === null) throw Error('connection_unknown');
      if (current.generation !== record.generation) throw Error('connection_changed');
      this.#db
        .prepare(
          `INSERT INTO ocean_plugin_consents(connection_id, generation, endpoint, consented_at, used_at)
           VALUES (?,?,?,?,NULL) ON CONFLICT(connection_id, generation) DO UPDATE
           SET endpoint = excluded.endpoint, consented_at = excluded.consented_at, used_at = NULL`,
        )
        .run(record.connectionId, record.generation, record.endpoint, record.consentedAt);
      this.#db
        .prepare(
          `UPDATE ocean_plugin_connections
           SET consented_generation = ?, consented_at = ? WHERE id = ?`,
        )
        .run(record.generation, record.consentedAt, record.connectionId);
    });
  }
  consents(connectionId: string): readonly PluginDiscoveryConsentRecord[] {
    return this.#db
      .prepare(
        'SELECT connection_id, generation, endpoint, consented_at, used_at FROM ocean_plugin_consents WHERE connection_id = ? ORDER BY generation',
      )
      .all(connectionId)
      .map((row) => ({
        connectionId: String(row['connection_id']),
        generation: Number(row['generation']),
        endpoint: String(row['endpoint']),
        consentedAt: String(row['consented_at']),
        usedAt: row['used_at'] === null ? null : String(row['used_at']),
      }));
  }
  consumeConsent(connectionId: string, generation: number, endpoint: string, at: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE ocean_plugin_consents SET used_at = ?
         WHERE connection_id = ? AND generation = ? AND endpoint = ? AND used_at IS NULL`,
      )
      .run(at, connectionId, generation, endpoint);
    return result.changes === 1;
  }
  publishDiscovery(input: PluginDiscoveryPublication): PluginDiscoveryPublicationResult {
    return withImmediateTransaction(this.#db, () => {
      const current = readConnection(this.#db, input.connectionId);
      if (current === null) throw Error('connection_unknown');
      if (current.generation !== input.expectedGeneration) throw Error('connection_changed');
      // Initial establishment has no prior authority to invalidate; later movement does.
      const authorityChanged =
        current.schemaDigest !== null &&
        (current.schemaDigest !== input.schemaDigest ||
          current.identity !== input.identity.identity ||
          current.identityVerified !== input.identity.verified);
      let generation = current.generation;
      let revokedGrants = 0;
      if (authorityChanged) {
        generation += 1;
        revokedGrants = revokeGrantsForConnection(this.#db, current.id, input.discoveredAt);
        revokeConfirmationsForConnection(this.#db, current.id, input.discoveredAt);
        deleteConsents(this.#db, current.id);
      }
      this.#db
        .prepare(
          `UPDATE ocean_plugin_connections SET
           plugin_version = ?, adapter_version = ?, schema_digest = ?, tools = ?,
           identity = ?, identity_verified = ?, generation = ?, last_discovery_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.pluginVersion,
          input.adapterVersion,
          input.schemaDigest,
          JSON.stringify(input.tools),
          input.identity.identity,
          input.identity.verified ? 1 : 0,
          generation,
          input.discoveredAt,
          input.discoveredAt,
          input.connectionId,
        );
      return {
        connection: readConnection(this.#db, input.connectionId)!,
        authorityChanged,
        revokedGrants,
      };
    });
  }
  disconnect(connectionId: string, at: string): PluginConnectionRecord {
    return withImmediateTransaction(this.#db, () => {
      const current = readConnection(this.#db, connectionId);
      if (current === null) throw Error('connection_unknown');
      if (current.state === 'disconnected') return current;
      this.#db
        .prepare(
          `UPDATE ocean_plugin_connections
           SET state = 'disconnected', generation = generation + 1, updated_at = ? WHERE id = ?`,
        )
        .run(at, connectionId);
      revokeGrantsForConnection(this.#db, connectionId, at);
      revokeConfirmationsForConnection(this.#db, connectionId, at);
      deleteConsents(this.#db, connectionId);
      return readConnection(this.#db, connectionId)!;
    });
  }
  invalidateRestored(at: string): void {
    withImmediateTransaction(this.#db, () => {
      for (const row of this.#db
        .prepare("SELECT id FROM ocean_plugin_connections WHERE state = 'active'")
        .all()) {
        const id = String(row['id']);
        this.#db
          .prepare(
            `UPDATE ocean_plugin_connections
             SET state = 'disconnected', generation = generation + 1, updated_at = ? WHERE id = ?`,
          )
          .run(at, id);
      }
      this.#db
        .prepare(
          `UPDATE ocean_plugin_grants SET state = 'revoked', revoked_at = ?
           WHERE state = 'active'`,
        )
        .run(at);
      this.#db
        .prepare(
          `UPDATE ocean_plugin_confirmations SET state = 'revoked', revoked_at = ?
           WHERE state = 'pending'`,
        )
        .run(at);
      this.#db.prepare('DELETE FROM ocean_plugin_consents').run();
    });
  }
}
