/* eslint-disable no-restricted-imports -- Test-only fakes for the application package's plugin ports. */
import type {
  PluginAccessStorePort,
  PluginAccessTransaction,
  PluginAdmissionStorePort,
  PluginAdmissionTransaction,
  PluginCredentialReferencePort,
  PluginGrantScopeFacts,
} from '../src/plugin-ports.js';
import type { PluginOperationStorePort } from '../src/plugin-operation-ports.js';
import type { PluginOperationRecord } from '@runnets/domain';
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
          // Mirror SqliteToolJournal.claimNow: any unresolved claim holds new claims.
          for (const [claimed, outcome] of maps.settled)
            if (
              !['completed', 'failed', 'not_started'].includes(outcome) &&
              !maps.resolved.has(claimed)
            )
              return false;
          for (const claimed of maps.claims.keys()) if (!maps.settled.has(claimed)) return false;
          maps.claims.set(id, tool + ':' + fingerprint);
          return true;
        },
        beginOperation(record) {
          if (maps.operations.has(record.id)) throw Error('operation_exists');
          maps.operations.set(record.id, clone(record));
        },
      });
    },
    settle(id, outcome) {
      if (!maps.claims.has(id) || maps.settled.has(id))
        throw Error('tool claim is missing or already settled');
      maps.settled.set(id, outcome);
    },
    settleOperation(id, settlement, journalOutcome) {
      const operation = maps.operations.get(id);
      if (operation === undefined || operation.state !== 'started')
        throw Error('plugin operation is missing or already settled');
      if (!maps.claims.has(id) || maps.settled.has(id))
        throw Error('tool claim is missing or already settled');
      maps.settled.set(id, journalOutcome);
      maps.operations.set(id, {
        ...operation,
        state: settlement.state,
        outcomeCode: settlement.outcomeCode,
        detail: settlement.detail,
        resultSummary: settlement.resultSummary,
        resultBytes: settlement.resultBytes,
        truncated: settlement.truncated,
        settledAt: settlement.settledAt,
        revision: operation.revision + 1,
      });
    },
  };
}

/** In-memory operation journal mirroring the SQLite adapter's semantics. */
export function fakeOperationStore(maps: PluginFakeMaps): PluginOperationStorePort {
  return {
    list: (filter = {}) =>
      [...maps.operations.values()]
        .filter(
          (operation) =>
            (filter.workspaceId === undefined || operation.workspaceId === filter.workspaceId) &&
            (filter.roomId === undefined || operation.roomId === filter.roomId) &&
            (filter.botId === undefined || operation.botId === filter.botId) &&
            (filter.state === undefined || operation.state === filter.state),
        )
        .slice(0, filter.limit ?? 50)
        .map(clone),
    get: (id) => {
      const row = maps.operations.get(id);
      return row === undefined ? null : clone(row);
    },
    open: () =>
      [...maps.operations.values()]
        .filter((operation) => operation.state === 'started' || operation.state === 'uncertain')
        .map(clone),
    recoverStarted(at) {
      let lowered = 0;
      for (const [id, operation] of maps.operations) {
        if (operation.state !== 'started') continue;
        maps.operations.set(id, {
          ...operation,
          state: 'uncertain',
          outcomeCode: 'interrupted',
          detail: 'runtime restarted before the operation settled',
          settledAt: at,
          revision: operation.revision + 1,
        });
        const claimed = maps.claims.has(id);
        if (claimed && !maps.settled.has(id)) maps.settled.set(id, 'uncertain');
        lowered += 1;
      }
      return lowered;
    },
    acknowledge(input) {
      const operation = maps.operations.get(input.operationId);
      if (operation === undefined) throw refuse('operation_unknown');
      if (operation.state !== 'uncertain') throw refuse('operation_not_uncertain');
      if (operation.revision !== input.expectedRevision) throw refuse('operation_conflict');
      const next: PluginOperationRecord = {
        ...operation,
        state: 'acknowledged',
        acknowledgedAt: input.at,
        acknowledgedReason: input.reason.length === 0 ? null : input.reason,
        revision: operation.revision + 1,
      };
      maps.operations.set(next.id, next);
      maps.resolved.add(next.id);
      return clone(next);
    },
  };
}

function refuse(code: string): Error {
  return Object.assign(Error('plugin operation refused: ' + code), { code });
}

export function fakeCredentials(present = 'OCEAN_TEST_PRESENT'): PluginCredentialReferencePort {
  return { available: (reference) => reference === present };
}
