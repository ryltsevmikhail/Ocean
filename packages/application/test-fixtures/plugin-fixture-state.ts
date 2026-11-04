/* eslint-disable no-restricted-imports -- Test-only in-memory plugin state. */
/**
 * Assembles one shared in-memory plugin state behind every plugin port, plus the
 * failure seams tests use for interrupted/corrupt installs.
 */
import type {
  PluginAdmissionStorePort,
  PluginCatalogStorePort,
  PluginConnectionStorePort,
  PluginCredentialReferencePort,
  PluginDiscoveryConsentRecord,
  PluginInstallStorePort,
  PluginRoomFacts,
} from '../src/plugin-ports.js';
import type { PluginGrantRecord } from '@runnets/domain';
import {
  pluginFakeMaps,
  type PluginFakeMaps,
  type MockGrantConfirmation,
} from './plugin-fake-state.js';
import { fakeCatalogStore, fakeConnectionStore, fakeInstallFiles } from './plugin-store-fakes.js';
import {
  fakeAccessStore,
  fakeAdmissionStore,
  fakeCredentials,
  type FakeAccessStore,
} from './plugin-authority-fakes.js';

export interface PluginFixtureState {
  readonly catalog: PluginCatalogStorePort;
  readonly installFiles: PluginInstallStorePort;
  readonly connections: PluginConnectionStorePort;
  readonly access: FakeAccessStore;
  readonly admission: PluginAdmissionStorePort;
  readonly credentials: PluginCredentialReferencePort;
  readonly versions: Map<string, PluginInstalledVersion>;
  readonly grants: Map<string, PluginGrantRecord>;
  readonly confirmations: Map<string, MockGrantConfirmation>;
  readonly members: Set<string>;
  readonly rooms: Map<string, PluginRoomFacts>;
  readonly claims: Map<string, string>;
  readonly settled: Map<string, string>;
  readonly counts: PluginFakeMaps['counts'];
  readonly consents: Map<string, PluginDiscoveryConsentRecord[]>;
  failFilePublish(error: Error | null): void;
  overrideFileDigest(digest: string | null): void;
  corruptInstalled(pluginId: string, version: string): void;
}

export function pluginFixtureState(): PluginFixtureState {
  const maps = pluginFakeMaps();
  return {
    catalog: fakeCatalogStore(maps),
    installFiles: fakeInstallFiles(maps),
    connections: fakeConnectionStore(maps),
    access: fakeAccessStore(maps),
    admission: fakeAdmissionStore(maps),
    credentials: fakeCredentials(),
    versions: maps.versions,
    grants: maps.grants,
    confirmations: maps.confirmations,
    members: maps.members,
    rooms: maps.rooms,
    claims: maps.claims,
    settled: maps.settled,
    counts: maps.counts,
    consents: maps.consents,
    failFilePublish(error) {
      maps.fileState.failure = error;
    },
    overrideFileDigest(digest) {
      maps.fileState.digestOverride = digest;
    },
    corruptInstalled(pluginId, version) {
      const key = pluginId + '@' + version;
      const entry = maps.files.get(key);
      if (entry !== undefined) maps.files.set(key, { ...entry, sha256: 'a'.repeat(64) });
    },
  };
}
