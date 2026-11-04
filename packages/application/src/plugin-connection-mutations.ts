/**
 * Owner-facing plugin connection mutations (authority changes and disconnect).
 *
 * A generation bump and its grant/confirmation revocation happen inside the
 * durable connection store's transaction; this module only validates the
 * owner-facing patch and delegates.
 */

import {
  validCredentialReference,
  validPluginConnectionName,
  validPluginEndpoint,
  type PluginAdapterIdentity,
} from '@runnets/domain';
import {
  PluginRefusedError,
  pluginAdapterVersion,
  type PluginConnectionRecord,
  type PluginConnectionStorePort,
  type PluginVersionReadPort,
} from './plugin-ports.js';
import type {
  PluginAddConnectionInput,
  PluginChangeConnectionInput,
  PluginConnectionView,
} from './plugin-connection-views.js';

export interface ConnectionMutationDeps {
  readonly store: PluginConnectionStorePort;
  readonly view: (connection: PluginConnectionRecord) => PluginConnectionView;
  readonly now: () => string;
  readonly connection: (connectionId: string) => PluginConnectionRecord;
  readonly requireGeneration?: (connection: PluginConnectionRecord, expected: number) => void;
}

function refuse(code: string): PluginRefusedError {
  return new PluginRefusedError(code, 'plugin connection refused: ' + code);
}

export function changePluginConnection(
  deps: ConnectionMutationDeps,
  input: PluginChangeConnectionInput,
): PluginConnectionView {
  const connection = deps.connection(input.connectionId);
  deps.requireGeneration?.(connection, input.expectedGeneration);
  if (connection.generation !== input.expectedGeneration) throw refuse('connection_changed');
  const patch: {
    credentialReference?: string;
    accountLabel?: string | null;
    endpoint?: string;
  } = {};
  if (input.credentialReference !== undefined) {
    if (!validCredentialReference(input.credentialReference))
      throw refuse('invalid_credential_reference');
    patch.credentialReference = input.credentialReference;
  }
  if (input.accountLabel !== undefined) {
    const label = input.accountLabel?.trim() ?? null;
    if (label !== null && (label.length === 0 || label.length > 256))
      throw refuse('invalid_account_label');
    patch.accountLabel = label;
  }
  if (input.endpoint !== undefined) {
    if (!validPluginEndpoint(input.endpoint)) throw refuse('invalid_endpoint');
    if (input.endpoint !== connection.endpoint) throw refuse('endpoint_locked');
    patch.endpoint = input.endpoint;
  }
  if (Object.keys(patch).length === 0) throw refuse('no_change');
  return deps.view(deps.store.change(connection.id, connection.generation, patch, deps.now()));
}

export function disconnectPluginConnection(
  deps: ConnectionMutationDeps,
  connectionId: string,
): { connection: PluginConnectionView; revokedGrants: number } {
  const connection = deps.connection(connectionId);
  if (connection.state === 'disconnected')
    return { connection: deps.view(connection), revokedGrants: 0 };
  const closed = deps.store.disconnect(connection.id, deps.now());
  return { connection: deps.view(closed.connection), revokedGrants: closed.revokedGrants };
}

export interface ConnectionAddDeps {
  readonly store: PluginConnectionStorePort;
  readonly versions: PluginVersionReadPort;
  readonly adapter: PluginAdapterIdentity;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly view: (connection: PluginConnectionRecord) => PluginConnectionView;
}

export function addPluginConnection(
  deps: ConnectionAddDeps,
  input: PluginAddConnectionInput,
): PluginConnectionView {
  if (!validPluginConnectionName(input.name)) throw refuse('invalid_connection_name');
  if (!validCredentialReference(input.credentialReference))
    throw refuse('invalid_credential_reference');
  const accountLabel = input.accountLabel?.trim() ?? '';
  if (accountLabel.length > 256) throw refuse('invalid_account_label');
  const record = deps.versions.enabled(input.pluginId);
  if (record === null) throw refuse('plugin_not_enabled');
  const now = deps.now();
  const connection: PluginConnectionRecord = {
    id: deps.nextId(),
    name: input.name,
    pluginId: record.pluginId,
    pluginVersion: record.version,
    adapterVersion: pluginAdapterVersion(deps.adapter),
    endpoint: record.manifest.endpoint,
    credentialReference: input.credentialReference,
    accountLabel: accountLabel === '' ? null : accountLabel,
    identity: null,
    identityVerified: false,
    state: 'active',
    generation: 1,
    schemaDigest: null,
    tools: null,
    consentedGeneration: null,
    consentedAt: null,
    lastDiscoveryAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    deps.store.add(connection);
  } catch (error) {
    if (error instanceof Error && error.message === 'connection_exists')
      throw refuse('connection_exists');
    throw error;
  }
  return deps.view(connection);
}
