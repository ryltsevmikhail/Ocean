/* eslint-disable no-restricted-imports -- Test-only fakes for the application package's plugin ports. */
import type {
  PluginConnectionRecord,
  PluginDiscoveryConsentRecord,
  PluginInstalledVersion,
  PluginRoomFacts,
} from '../src/plugin-ports.js';
import type { PluginGrantRecord } from '@runnets/domain';
import type { PluginManifest } from '@runnets/domain';

export const clone = <T>(value: T): T => structuredClone(value);
export const versionKey = (pluginId: string, version: string) => pluginId + '@' + version;

export interface MockGrantConfirmation {
  readonly id: string;
  readonly connectionId: string;
  readonly generation: number;
  state: 'pending' | 'revoked' | 'consumed';
}

export interface PluginFakeMaps {
  readonly versions: Map<string, PluginInstalledVersion>;
  readonly files: Map<string, { manifest: PluginManifest; bytes: number; sha256: string }>;
  readonly connections: Map<string, PluginConnectionRecord>;
  readonly consents: Map<string, PluginDiscoveryConsentRecord[]>;
  readonly grants: Map<string, PluginGrantRecord>;
  readonly confirmations: Map<string, MockGrantConfirmation>;
  readonly members: Set<string>;
  readonly rooms: Map<string, PluginRoomFacts>;
  readonly claims: Map<string, string>;
  readonly settled: Map<string, string>;
  readonly counts: { revokedGrants: number; revokedConfirmations: number; publishCalls: number };
  readonly fileState: { failure: Error | null; digestOverride: string | null };
}

export function pluginFakeMaps(): PluginFakeMaps {
  return {
    versions: new Map(),
    files: new Map(),
    connections: new Map(),
    consents: new Map(),
    grants: new Map(),
    confirmations: new Map(),
    members: new Set(),
    rooms: new Map(),
    claims: new Map(),
    settled: new Map(),
    counts: { revokedGrants: 0, revokedConfirmations: 0, publishCalls: 0 },
    fileState: { failure: null, digestOverride: null },
  };
}

export function revokeGrantsFor(
  maps: PluginFakeMaps,
  match: (grant: PluginGrantRecord) => boolean,
  at: string,
): number {
  let revoked = 0;
  for (const [id, grant] of maps.grants) {
    if (grant.state !== 'active' || !match(grant)) continue;
    maps.grants.set(id, { ...grant, state: 'revoked', revokedAt: at });
    revoked++;
  }
  maps.counts.revokedGrants += revoked;
  return revoked;
}

export function revokeConfirmationsFor(
  maps: PluginFakeMaps,
  match: (confirmation: MockGrantConfirmation) => boolean,
): number {
  let revoked = 0;
  for (const [id, confirmation] of maps.confirmations) {
    if (confirmation.state !== 'pending' || !match(confirmation)) continue;
    maps.confirmations.set(id, { ...confirmation, state: 'revoked' });
    revoked++;
  }
  maps.counts.revokedConfirmations += revoked;
  return revoked;
}
