/* eslint-disable no-restricted-imports -- Test-only fakes for the application package's plugin ports. */
import type {
  PluginCatalogStorePort,
  PluginConnectionPatch,
  PluginConnectionRecord,
  PluginConnectionStorePort,
  PluginInstallState,
  PluginInstallStorePort,
} from '../src/plugin-ports.js';
import type {
  PluginDiscoveryPublication,
  PluginDiscoveryPublicationResult,
} from '../src/plugin-ports.js';
import {
  clone,
  revokeConfirmationsFor,
  revokeGrantsFor,
  versionKey,
  type PluginFakeMaps,
} from './plugin-fake-state.js';

export function fakeCatalogStore(maps: PluginFakeMaps): PluginCatalogStorePort {
  return {
    plugins: () => [...new Set([...maps.versions.values()].map((row) => row.pluginId))].sort(),
    versions: (pluginId) =>
      [...maps.versions.values()].filter((row) => row.pluginId === pluginId).map(clone),
    version: (pluginId, version) => {
      const row = maps.versions.get(versionKey(pluginId, version));
      return row === undefined ? null : clone(row);
    },
    enabled: (pluginId) => {
      const row = [...maps.versions.values()].find(
        (entry) => entry.pluginId === pluginId && entry.enabled,
      );
      return row === undefined ? null : clone(row);
    },
    beginInstall(version) {
      const existing = maps.versions.get(versionKey(version.pluginId, version.version));
      if (
        existing !== undefined &&
        existing.state !== 'corrupt' &&
        existing.state !== 'interrupted'
      )
        throw Error('already_installed');
      maps.versions.set(versionKey(version.pluginId, version.version), clone(version));
    },
    markVerified(pluginId, version, file, verifiedAt) {
      const row = maps.versions.get(versionKey(pluginId, version));
      if (row === undefined || row.state === 'corrupt') return false;
      maps.versions.set(versionKey(pluginId, version), {
        ...row,
        state: 'installed',
        fileDigest: file.sha256,
        verifiedAt,
      });
      return true;
    },
    setState(pluginId, version, state: PluginInstallState) {
      const row = maps.versions.get(versionKey(pluginId, version));
      if (row !== undefined) maps.versions.set(versionKey(pluginId, version), { ...row, state });
    },
    setEnabled(pluginId, version, enabled, at, revoke) {
      for (const [id, row] of maps.versions) {
        if (row.pluginId === pluginId && row.enabled && id !== versionKey(pluginId, version))
          maps.versions.set(id, { ...row, enabled: false });
      }
      const row = maps.versions.get(versionKey(pluginId, version));
      if (row !== undefined) maps.versions.set(versionKey(pluginId, version), { ...row, enabled });
      let revoked = 0;
      if (revoke) {
        revoked = revokeGrantsFor(maps, (grant) => grant.pluginId === pluginId, at);
        revokeConfirmationsFor(maps, (confirmation) => {
          const connection = maps.connections.get(confirmation.connectionId);
          return connection?.pluginId === pluginId;
        });
      }
      return revoked;
    },
  };
}

export function fakeInstallFiles(maps: PluginFakeMaps): PluginInstallStorePort {
  return {
    publish(pluginId, version, manifest) {
      if (maps.fileState.failure !== null) throw maps.fileState.failure;
      const digest =
        maps.fileState.digestOverride ??
        maps.versions.get(versionKey(pluginId, version))?.manifestDigest ??
        '';
      const bytes = JSON.stringify(manifest).length;
      maps.files.set(versionKey(pluginId, version), {
        manifest: clone(manifest),
        bytes,
        sha256: digest,
      });
      return { relativePath: 'manifest.json', sha256: digest, bytes };
    },
    repair(pluginId, version, manifest) {
      if (maps.fileState.failure !== null) throw maps.fileState.failure;
      const digest = maps.versions.get(versionKey(pluginId, version))?.manifestDigest ?? '';
      const bytes = JSON.stringify(manifest).length;
      maps.files.set(versionKey(pluginId, version), {
        manifest: clone(manifest),
        bytes,
        sha256: digest,
      });
      return { relativePath: 'manifest.json', sha256: digest, bytes };
    },
    read(pluginId, version) {
      const file = maps.files.get(versionKey(pluginId, version));
      if (file === undefined) return { status: 'missing', reason: 'missing_file' };
      return { status: 'ok', bytes: file.bytes, sha256: file.sha256 };
    },
  };
}

export function fakeConnectionStore(maps: PluginFakeMaps): PluginConnectionStorePort {
  return {
    list: () => [...maps.connections.values()].map(clone),
    get: (id) => {
      const row = maps.connections.get(id);
      return row === undefined ? null : clone(row);
    },
    add(record) {
      if (
        [...maps.connections.values()].some(
          (row) => row.pluginId === record.pluginId && row.name === record.name,
        )
      )
        throw Error('connection_exists');
      maps.connections.set(record.id, clone(record));
    },
    change(id, expectedGeneration, patch: PluginConnectionPatch, at) {
      const row = maps.connections.get(id);
      if (row === undefined) throw Error('connection_unknown');
      if (row.generation !== expectedGeneration) throw Error('connection_changed');
      const changed: PluginConnectionRecord = {
        ...row,
        ...patch,
        generation: row.generation + 1,
        schemaDigest: null,
        tools: null,
        identity: null,
        identityVerified: false,
        lastDiscoveryAt: null,
        consentedGeneration: null,
        consentedAt: null,
        updatedAt: at,
      };
      maps.connections.set(id, clone(changed));
      revokeGrantsFor(maps, (grant) => grant.connectionId === id, at);
      revokeConfirmationsFor(maps, (confirmation) => confirmation.connectionId === id);
      maps.consents.set(id, []);
      return clone(changed);
    },
    consent(record) {
      const row = maps.connections.get(record.connectionId);
      if (row === undefined) throw Error('connection_unknown');
      const list = maps.consents.get(record.connectionId) ?? [];
      maps.consents.set(record.connectionId, [
        ...list.filter((entry) => entry.generation !== record.generation),
        clone({ ...record, usedAt: null }),
      ]);
      maps.connections.set(record.connectionId, {
        ...row,
        consentedGeneration: record.generation,
        consentedAt: record.consentedAt,
      });
    },
    consents: (connectionId) => clone(maps.consents.get(connectionId) ?? []),
    consumeConsent(connectionId, generation, endpoint, at) {
      const list = maps.consents.get(connectionId) ?? [];
      const index = list.findIndex(
        (entry) =>
          entry.generation === generation && entry.endpoint === endpoint && entry.usedAt === null,
      );
      if (index === -1) return false;
      const consumed = [...list];
      consumed[index] = { ...list[index]!, usedAt: at };
      maps.consents.set(connectionId, consumed);
      return true;
    },
    publishDiscovery(input: PluginDiscoveryPublication): PluginDiscoveryPublicationResult {
      maps.counts.publishCalls++;
      const row = maps.connections.get(input.connectionId);
      if (row === undefined) throw Error('connection_unknown');
      if (row.generation !== input.expectedGeneration) throw Error('connection_changed');
      const authorityChanged =
        row.schemaDigest !== null &&
        (row.schemaDigest !== input.schemaDigest ||
          row.identity !== input.identity.identity ||
          row.identityVerified !== input.identity.verified);
      let revoked = 0;
      let generation = row.generation;
      if (authorityChanged) {
        generation += 1;
        revoked = revokeGrantsFor(
          maps,
          (grant) => grant.connectionId === row.id,
          input.discoveredAt,
        );
        revokeConfirmationsFor(maps, (confirmation) => confirmation.connectionId === row.id);
        maps.consents.set(row.id, []);
      }
      const updated: PluginConnectionRecord = {
        ...row,
        generation,
        pluginVersion: input.pluginVersion,
        adapterVersion: input.adapterVersion,
        schemaDigest: input.schemaDigest,
        tools: clone(input.tools),
        identity: input.identity.identity,
        identityVerified: input.identity.verified,
        lastDiscoveryAt: input.discoveredAt,
        updatedAt: input.discoveredAt,
      };
      maps.connections.set(row.id, clone(updated));
      return { connection: clone(updated), authorityChanged, revokedGrants: revoked };
    },
    disconnect(id, at) {
      const row = maps.connections.get(id);
      if (row === undefined) throw Error('connection_unknown');
      if (row.state === 'disconnected') return { connection: clone(row), revokedGrants: 0 };
      const updated: PluginConnectionRecord = {
        ...row,
        state: 'disconnected',
        generation: row.generation + 1,
        updatedAt: at,
      };
      maps.connections.set(id, clone(updated));
      const revokedGrants = revokeGrantsFor(maps, (grant) => grant.connectionId === id, at);
      revokeConfirmationsFor(maps, (confirmation) => confirmation.connectionId === id);
      maps.consents.set(id, []);
      return { connection: clone(updated), revokedGrants };
    },
    invalidateRestored(at) {
      for (const [id, row] of maps.connections) {
        if (row.state === 'active')
          maps.connections.set(id, {
            ...row,
            state: 'disconnected',
            generation: row.generation + 1,
            updatedAt: at,
          });
        revokeGrantsFor(maps, (grant) => grant.connectionId === id, at);
        revokeConfirmationsFor(maps, (confirmation) => confirmation.connectionId === id);
      }
    },
  };
}
