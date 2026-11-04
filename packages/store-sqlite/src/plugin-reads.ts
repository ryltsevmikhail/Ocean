/**
 * Row decoding and shared authority SQL for the plugin adapters.
 *
 * Every helper takes the caller's DatabaseSync and never opens a transaction of
 * its own; callers decide the transaction boundary so authority changes and
 * revocations commit atomically.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  PluginAdapterCompatibility,
  PluginGrantRecord,
  PluginManifest,
} from '@runnets/domain';
import type {
  PluginConnectionRecord,
  PluginGrantScopeFacts,
  PluginInstalledVersion,
  PluginInstallState,
  PluginRoomFacts,
} from '@runnets/application';
import type { ServicePluginTool } from '@runnets/application';
import { readText } from './rows.js';

const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value === null || value === undefined) return '';
  throw new Error('invalid plugin row column');
};

export function versionRow(value: unknown): PluginInstalledVersion | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  try {
    const manifest = JSON.parse(text(row['manifest'])) as PluginManifest;
    const adapter = JSON.parse(text(row['adapter'])) as PluginAdapterCompatibility;
    const state = text(row['state']) as PluginInstallState;
    if (!['installing', 'installed', 'interrupted', 'corrupt'].includes(state)) return null;
    return {
      pluginId: text(row['plugin_id']),
      version: text(row['version']),
      publisher: text(row['publisher']),
      title: text(row['title']),
      manifest,
      manifestDigest: text(row['manifest_digest']),
      adapter,
      state,
      enabled: Number(row['enabled']) === 1,
      fileDigest: row['file_digest'] === null ? null : text(row['file_digest']),
      installedAt: text(row['installed_at']),
      verifiedAt: row['verified_at'] === null ? null : text(row['verified_at']),
    };
  } catch {
    return null;
  }
}

export function toolsRow(value: unknown): readonly ServicePluginTool[] | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = JSON.parse(text(value)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const tools: ServicePluginTool[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') return null;
      const tool = entry as Record<string, unknown>;
      if (typeof tool['name'] !== 'string' || typeof tool['description'] !== 'string') return null;
      tools.push({
        name: tool['name'],
        description: tool['description'],
        inputSchema: (tool['inputSchema'] ?? null) as ServicePluginTool['inputSchema'],
      });
    }
    return tools;
  } catch {
    return null;
  }
}

export function connectionRow(value: unknown): PluginConnectionRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const state = text(row['state']);
  if (state !== 'active' && state !== 'disconnected') return null;
  const tools = toolsRow(row['tools']);
  return {
    id: text(row['id']),
    name: text(row['name']),
    pluginId: text(row['plugin_id']),
    pluginVersion: text(row['plugin_version']),
    adapterVersion: text(row['adapter_version']),
    endpoint: text(row['endpoint']),
    credentialReference: text(row['credential_ref']),
    accountLabel: row['account_label'] === null ? null : text(row['account_label']),
    identity: row['identity'] === null ? null : text(row['identity']),
    identityVerified: Number(row['identity_verified']) === 1,
    state,
    generation: Number(row['generation']),
    schemaDigest: row['schema_digest'] === null ? null : text(row['schema_digest']),
    tools,
    consentedGeneration:
      row['consented_generation'] === null ? null : Number(row['consented_generation']),
    consentedAt: row['consented_at'] === null ? null : text(row['consented_at']),
    lastDiscoveryAt: row['last_discovery_at'] === null ? null : text(row['last_discovery_at']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
  };
}

export function grantRow(value: unknown): PluginGrantRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const state = text(row['state']);
  if (state !== 'active' && state !== 'revoked') return null;
  try {
    const tools = JSON.parse(text(row['tools'])) as unknown;
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) return null;
    return {
      id: text(row['id']),
      workspaceId: text(row['workspace_id']),
      roomId: text(row['room_id']),
      botId: text(row['bot_id']),
      pluginId: text(row['plugin_id']),
      connectionId: text(row['connection_id']),
      connectionGeneration: Number(row['connection_generation']),
      tools: tools as string[],
      repository: text(row['repository']),
      schemaDigest: text(row['schema_digest']),
      policyVersion: Number(row['policy_version']),
      visibility: text(row['visibility']),
      state,
      createdAt: text(row['created_at']),
      revokedAt: row['revoked_at'] === null ? null : text(row['revoked_at']),
    };
  } catch {
    return null;
  }
}

export function readConnection(db: DatabaseSync, id: string): PluginConnectionRecord | null {
  return connectionRow(db.prepare('SELECT * FROM ocean_plugin_connections WHERE id = ?').get(id));
}

export function readVersion(
  db: DatabaseSync,
  pluginId: string,
  version: string,
): PluginInstalledVersion | null {
  return versionRow(
    db
      .prepare('SELECT * FROM ocean_plugin_versions WHERE plugin_id = ? AND version = ?')
      .get(pluginId, version),
  );
}

export function readEnabled(db: DatabaseSync, pluginId: string): PluginInstalledVersion | null {
  return versionRow(
    db
      .prepare('SELECT * FROM ocean_plugin_versions WHERE plugin_id = ? AND enabled = 1')
      .get(pluginId),
  );
}

export function readGrant(db: DatabaseSync, id: string): PluginGrantRecord | null {
  return grantRow(db.prepare('SELECT * FROM ocean_plugin_grants WHERE id = ?').get(id));
}

export function isMember(
  db: DatabaseSync,
  workspaceId: string,
  roomId: string,
  botId: string,
): boolean {
  return (
    db
      .prepare('SELECT 1 FROM ocean_members WHERE workspace_id = ? AND room_id = ? AND bot_id = ?')
      .get(workspaceId, roomId, botId) !== undefined
  );
}

export function roomFacts(db: DatabaseSync, roomId: string): PluginRoomFacts | null {
  const row = db.prepare('SELECT id, kind, title FROM ocean_rooms WHERE id = ?').get(roomId);
  if (row === undefined) return null;
  const kind = readText(row, 'kind');
  if (kind !== 'direct' && kind !== 'group') return null;
  const participants = db
    .prepare('SELECT count(*) AS n FROM ocean_members WHERE room_id = ?')
    .get(roomId);
  return {
    id: readText(row, 'id'),
    kind,
    title: row['title'] === null ? null : readText(row, 'title'),
    participantCount: Number(participants?.['n'] ?? 0),
  };
}

export function activeGrants(
  db: DatabaseSync,
  scope: PluginGrantScopeFacts,
): readonly PluginGrantRecord[] {
  return db
    .prepare(
      `SELECT * FROM ocean_plugin_grants
       WHERE state = 'active' AND workspace_id = ? AND room_id = ? AND bot_id = ?
         AND plugin_id = ? ORDER BY created_at, id`,
    )
    .all(scope.workspaceId, scope.roomId, scope.botId, scope.pluginId)
    .map((row) => grantRow(row))
    .filter((grant): grant is PluginGrantRecord => grant !== null);
}

/** Revoke active grants of one connection; caller owns the transaction. */
export function revokeGrantsForConnection(
  db: DatabaseSync,
  connectionId: string,
  at: string,
): number {
  return Number(
    db
      .prepare(
        `UPDATE ocean_plugin_grants SET state = 'revoked', revoked_at = ?
         WHERE connection_id = ? AND state = 'active'`,
      )
      .run(at, connectionId).changes,
  );
}

/** Revoke active grants of one plugin; caller owns the transaction. */
export function revokeGrantsForPlugin(db: DatabaseSync, pluginId: string, at: string): number {
  return Number(
    db
      .prepare(
        `UPDATE ocean_plugin_grants SET state = 'revoked', revoked_at = ?
         WHERE plugin_id = ? AND state = 'active'`,
      )
      .run(at, pluginId).changes,
  );
}

export function revokeConfirmationsForConnection(
  db: DatabaseSync,
  connectionId: string,
  at: string,
): number {
  return Number(
    db
      .prepare(
        `UPDATE ocean_plugin_confirmations SET state = 'revoked', revoked_at = ?
         WHERE connection_id = ? AND state = 'pending'`,
      )
      .run(at, connectionId).changes,
  );
}

export function revokeConfirmationsForPlugin(
  db: DatabaseSync,
  pluginId: string,
  at: string,
): number {
  return Number(
    db
      .prepare(
        `UPDATE ocean_plugin_confirmations SET state = 'revoked', revoked_at = ?
         WHERE state = 'pending' AND connection_id IN
           (SELECT id FROM ocean_plugin_connections WHERE plugin_id = ?)`,
      )
      .run(at, pluginId).changes,
  );
}

export function deleteConsents(db: DatabaseSync, connectionId: string): void {
  db.prepare('DELETE FROM ocean_plugin_consents WHERE connection_id = ?').run(connectionId);
}
