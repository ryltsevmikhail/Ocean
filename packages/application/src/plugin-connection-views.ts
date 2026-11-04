/**
 * Owner-facing plugin connection view mapping (plain data only).
 */

import { pluginIdentityLabel } from '@runnets/domain';
import type { PluginConnectionRecord } from './plugin-ports.js';

export interface PluginConnectionView {
  readonly id: string;
  readonly name: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly adapterVersion: string;
  readonly endpoint: string;
  readonly credentialReference: string;
  readonly accountLabel: string | null;
  readonly identity: string | null;
  readonly identityLabel: 'verified' | 'unverified';
  readonly state: 'active' | 'disconnected';
  readonly generation: number;
  readonly schemaDigest: string | null;
  readonly tools: readonly string[];
  readonly consented: boolean;
  readonly consentedGeneration: number | null;
  readonly consentedAt: string | null;
  readonly lastDiscoveryAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PluginConsentPreview {
  readonly connectionId: string;
  readonly name: string;
  readonly pluginId: string;
  readonly endpoint: string;
  readonly generation: number;
  readonly consented: boolean;
  readonly prompt: string;
}

export interface PluginDiscoveryResult {
  readonly connection: PluginConnectionView;
  readonly revokedGrants: number;
  readonly authorityChanged: boolean;
}

export interface PluginAddConnectionInput {
  readonly name: string;
  readonly pluginId: string;
  readonly credentialReference: string;
  readonly accountLabel?: string;
}

export interface PluginChangeConnectionInput {
  readonly connectionId: string;
  readonly expectedGeneration: number;
  readonly credentialReference?: string;
  readonly accountLabel?: string | null;
  readonly endpoint?: string;
}

/** Metadata-discovery prompt shown before the owner consents. */
export function pluginConsentPrompt(connection: PluginConnectionRecord): string {
  return (
    'Ocean will ask the service at ' +
    connection.endpoint +
    ' for its tool metadata once (at most 4 MiB and 256 tools). ' +
    'This performs no business operation and stores the resulting schema snapshot for connection "' +
    connection.name +
    '" generation ' +
    String(connection.generation) +
    '. Continue only if you trust this endpoint.'
  );
}

export function pluginConnectionView(
  connection: PluginConnectionRecord,
  consented: boolean,
): PluginConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    pluginId: connection.pluginId,
    pluginVersion: connection.pluginVersion,
    adapterVersion: connection.adapterVersion,
    endpoint: connection.endpoint,
    credentialReference: connection.credentialReference,
    accountLabel: connection.accountLabel,
    identity: connection.identity,
    identityLabel: pluginIdentityLabel(connection),
    state: connection.state,
    generation: connection.generation,
    schemaDigest: connection.schemaDigest,
    tools: (connection.tools ?? []).map((tool) => tool.name),
    consented,
    consentedGeneration: connection.consentedGeneration,
    consentedAt: connection.consentedAt,
    lastDiscoveryAt: connection.lastDiscoveryAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}
