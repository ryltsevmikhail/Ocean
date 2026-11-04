/* eslint-disable no-restricted-imports -- Test-only fakes for the application package's plugin ports. */
import type {
  PluginAccessStorePort,
  PluginAccessTransaction,
  PluginAdmissionStorePort,
  PluginAdmissionTransaction,
  PluginCredentialReferencePort,
  PluginGrantScopeFacts,
} from '../src/plugin-ports.js';
import { clone, revokeGrantsFor, type PluginFakeMaps } from './plugin-fake-state.js';

export interface FakeAccessStore extends PluginAccessStorePort {
  seedPendingConfirmation(id: string, connectionId: string, generation: number, at: string): void;
  pendingConfirmations(): readonly {
    readonly id: string;
    readonly state: 'pending' | 'revoked' | 'consumed';
  }[];
}

export function fakeAccessStore(maps: PluginFakeMaps): FakeAccessStore {
  return {
    atomic<T>(work: (tx: PluginAccessTransaction) => T): T {
      return work({
        member: (workspaceId, roomId, botId) =>
          maps.members.has(`${workspaceId}|${roomId}|${botId}`),
        room: (roomId) => {
          const room = maps.rooms.get(roomId);
          return room === undefined ? null : clone(room);
        },
        connection: (id) => {
          const row = maps.connections.get(id);
          return row === undefined ? null : clone(row);
        },
        enabledVersion: (pluginId) => {
          const row = [...maps.versions.values()].find(
            (entry) => entry.pluginId === pluginId && entry.enabled,
          );
          return row === undefined ? null : clone(row);
        },
        activeGrants: (scope: PluginGrantScopeFacts) =>
          [...maps.grants.values()].filter(
            (grant) =>
              grant.state === 'active' &&
              grant.workspaceId === scope.workspaceId &&
              grant.roomId === scope.roomId &&
              grant.botId === scope.botId &&
              grant.pluginId === scope.pluginId,
          ),
        grant: (id) => {
          const grant = maps.grants.get(id);
          return grant === undefined ? null : clone(grant);
        },
        putGrant: (record) => {
          // Mirror the real INSERT + table CHECK: no update of an existing row and a
          // revoked grant must carry its revocation timestamp.
          if (maps.grants.has(record.id)) throw Error('grant_exists');
          if ((record.state === 'revoked') !== (record.revokedAt !== null))
            throw Error('grant_check_failed');
          maps.grants.set(record.id, clone(record));
        },
        putGrantAndRevokePrevious(record, at) {
          maps.grants.set(record.id, clone(record));
          revokeGrantsFor(
            maps,
            (grant) =>
              grant.id !== record.id &&
              grant.workspaceId === record.workspaceId &&
              grant.roomId === record.roomId &&
              grant.botId === record.botId &&
              grant.pluginId === record.pluginId,
            at,
          );
        },
      });
    },
    grants: (filter = {}) =>
      [...maps.grants.values()]
        .filter(
          (grant) =>
            (filter.workspaceId === undefined || grant.workspaceId === filter.workspaceId) &&
            (filter.roomId === undefined || grant.roomId === filter.roomId) &&
            (filter.botId === undefined || grant.botId === filter.botId) &&
            (filter.pluginId === undefined || grant.pluginId === filter.pluginId),
        )
        .map(clone),
    revoke(id, at) {
      const grant = maps.grants.get(id);
      if (grant === undefined || grant.state !== 'active') return false;
      maps.grants.set(id, { ...grant, state: 'revoked', revokedAt: at });
      return true;
    },
    seedPendingConfirmation(id, connectionId, generation, _at) {
      maps.confirmations.set(id, { id, connectionId, generation, state: 'pending' });
    },
    pendingConfirmations: () => [...maps.confirmations.values()].map((entry) => ({ ...entry })),
  };
}

export function fakeAdmissionStore(maps: PluginFakeMaps): PluginAdmissionStorePort {
  return {
    atomic<T>(work: (tx: PluginAdmissionTransaction) => T): T {
      return work({
        member: (workspaceId, roomId, botId) =>
          maps.members.has(`${workspaceId}|${roomId}|${botId}`),
        connection: (id) => {
          const row = maps.connections.get(id);
          return row === undefined ? null : clone(row);
        },
        grant: (id) => {
          const grant = maps.grants.get(id);
          return grant === undefined ? null : clone(grant);
        },
        enabledVersion: (pluginId) => {
          const row = [...maps.versions.values()].find(
            (entry) => entry.pluginId === pluginId && entry.enabled,
          );
          return row === undefined ? null : clone(row);
        },
        claim(id, tool, _context, fingerprint) {
          if (maps.claims.has(id)) return false;
          maps.claims.set(id, tool + ':' + fingerprint);
          return true;
        },
      });
    },
    settle(id, outcome) {
      if (!maps.claims.has(id) || maps.settled.has(id))
        throw Error('tool claim is missing or already settled');
      maps.settled.set(id, outcome);
    },
  };
}

export function fakeCredentials(present = 'OCEAN_TEST_PRESENT'): PluginCredentialReferencePort {
  return { available: (reference) => reference === present };
}
