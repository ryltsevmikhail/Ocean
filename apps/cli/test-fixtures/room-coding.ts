/* eslint-disable no-restricted-imports -- CLI host composition fixture stays within this package. */
import type { CodingApprovalOwnerPort } from '@runnets/application';
import { createHash } from 'node:crypto';
import { vi, afterEach } from 'vitest';
import type * as Platform from '@runnets/tools-node';
import { ok, type ModelActivationSnapshot } from '@runnets/domain';
import {
  RoomTaskPersistence,
  TaskRunService,
  claimRoomDelivery,
  unconfiguredModelConnection,
  type ProviderActivationPort,
  type PreparedCodingOperation,
  type ToolInvocation,
  type ToolDispatchGuard,
} from '@runnets/application';
import {
  consumerFixture,
  projectId,
} from '../../../packages/store-sqlite/test-fixtures/coding-consumer.js';
import { codingTurnFactory } from '../src/coding-turn-factory.js';
const script = vi.hoisted(() => ({
  beforeRead: async () => {},
  beforePrepare: async () => {},
  beforeBinding: async () => {},
  beforeDispatch: () => {},
  writes: 0,
  tests: 0,
}));
const effects = vi.hoisted(() => ({ qualifications: 0, sessions: 0, reads: 0 }));
vi.mock('@runnets/tools-node', async (original) => ({
  ...(await original<typeof Platform>()),
  createCodingOperationSession: async (
    input: Parameters<typeof Platform.createCodingOperationSession>[0],
  ) => {
    effects.sessions++;
    return {
      read: async (_call: ToolInvocation, _signal: AbortSignal, guard?: ToolDispatchGuard) => {
        await script.beforeRead();
        if (guard && !guard.authorize()) throw Error('read guard refused');
        effects.reads++;
        return { isError: false, output: 'read' };
      },
      prepare: async (
        id: string,
        call: ToolInvocation,
        attemptId: string,
        guard?: ToolDispatchGuard,
      ): Promise<PreparedCodingOperation> => {
        await script.beforePrepare();
        if (guard && !guard.authorize()) throw Error('prepare refused');
        const operation = call.name === 'run_command' ? 'test' : 'write';
        const binding = {
          ...input.scope,
          workspaceId: input.task.workspaceId,
          taskId: input.task.id,
          projectRoot: input.task.projectRoot,
          worktreeRoot: input.task.worktreeRoot!,
          attemptId,
          invocationId: call.id,
          operation,
          policyVersion: 1,
          operationHash: '1'.repeat(64),
          sourceTreeHash: '2'.repeat(64),
          limitsHash: '3'.repeat(64),
          toolchainHash: '4'.repeat(64),
        } as const;
        return {
          approvalId: id,
          binding,
          guarded: true,
          currentBinding: async () => {
            await script.beforeBinding();
            return binding;
          },
          tool: {
            title: operation,
            kind: operation === 'write' ? 'edit' : 'execute',
            preview: operation === 'test' ? call.arguments + '\nlimits' : 'exact edit',
            execute: async (_signal, guard) => {
              script.beforeDispatch();
              if (!guard?.authorize()) throw Error('dispatch refused');
              script[operation === 'write' ? 'writes' : 'tests']++;
              return { isError: false, output: operation };
            },
          },
          ...(operation === 'test'
            ? {
                recordResult: () => {
                  const body = {
                    presetId: 'test',
                    id,
                    binding,
                    invocationHash: '5'.repeat(64),
                    beforeTreeHash: binding.sourceTreeHash,
                    afterTreeHash: binding.sourceTreeHash,
                    dependencyHash: '6'.repeat(64),
                    dependenciesUnchanged: true,
                    exitCode: 0,
                    reason: 'exit' as const,
                    cleanupConfirmed: true,
                    truncated: false,
                    output: 'test',
                  };
                  input.recordEvidence?.({
                    ...body,
                    hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
                  });
                },
              }
            : {}),
        };
      },
    };
  },
}));
afterEach(() => {
  effects.qualifications = 0;
  effects.sessions = 0;
  effects.reads = 0;
  script.beforeRead = async () => {};
  script.beforePrepare = async () => {};
  script.beforeBinding = async () => {};
  script.beforeDispatch = () => {};
  script.writes = 0;
  script.tests = 0;
});
export function setup(mode: 'autonomous' | 'confirm' = 'autonomous', selected = true) {
  const f = consumerFixture('ws_room');
  f.store.bindRoomHost({ ownerId: 'owner', epochId: null }, { origin: null, active: null });
  f.db.exec(
    "UPDATE ocean_rooms SET kind='group',bot_id=NULL,title='Team' WHERE id='room'; INSERT INTO ocean_members VALUES('ws_room','room','review')",
  );
  f.store.modelConnections.put(
    {
      ...unconfiguredModelConnection('test'),
      connectionId: 'cloud',
      intent: 'active',
      revision: 1,
      endpoint: 'https://fixture.invalid',
      defaultModelId: 'test',
    },
    null,
  );
  f.store.conversations.atomic((tx) => {
    for (const id of ['dev', 'review'])
      tx.putModelBinding(id, { connectionId: 'cloud', modelId: 'test' });
    tx.putRoomModelPolicy({ roomId: 'room', revision: 1, cloudTransfer: 'allow' });
  });
  const grant = f.grant();
  const permissions = grant.permissions.map((p) =>
    p.kind === 'coding'
      ? { ...p, actions: ['project_read', 'propose_write', 'run_test_preset'] as const }
      : p,
  );
  f.store.serviceAuthority.atomic((tx) =>
    tx.putGrant({ ...grant, revision: 2, permissions, mode }, 1),
  );
  let id = 0;
  const persistence = new RoomTaskPersistence({
    store: f.store.conversations,
    ownerId: 'owner',
    clock: f.deps.clock,
    sha256: projectId,
    nextId: () => `room_${++id}`,
  });
  const start = persistence.startHosted({
    workspaceId: 'ws_room',
    roomId: 'room',
    requestId: 'start-room',
    text: 'work',
    initialBotIds: ['dev'],
    participants: [
      { botId: 'dev', grantReferences: selected ? [{ grantId: grant.id, revision: 2 }] : [] },
      { botId: 'review', grantReferences: [] },
    ],
    mandate: { projectId: projectId(f.b.projectRoot), codingTaskId: f.b.id, permissions },
  });
  if (!start.ok) throw Error(start.error.code);
  const root = f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.value.rootId));
  if (root?.kind !== 'root') throw Error('root');
  const resolver: ProviderActivationPort = {
    resolve(bound, at) {
      const snapshot: ModelActivationSnapshot = {
        version: 1,
        identity: root.rootPayload.members.find((m) => m.botId === bound.bot.id)!.identity,
        capabilities: {
          tools: true,
          streaming: true,
          inputModalities: ['text'],
          contextTokens: null,
          maxOutputTokens: null,
          usage: 'reported',
        },
        limits: { maxModelRequests: 4, requestTimeoutMs: 60000, turnTimeoutMs: 600000 },
        admittedAt: at,
        deadlineAt: new Date(Date.parse(at) + 600000).toISOString(),
      };
      return ok({
        snapshot,
        provider: {
          id: 'test',
          models: ['test'],
          capabilities: { toolCalls: true, streaming: true, reasoning: false, usage: true },
          stream() {
            throw Error('no model fixture');
          },
        },
      });
    },
  };
  const claim = claimRoomDelivery(
    { ...persistence.deps, resolver, codingAvailable: true },
    start.value.deliveries[0]!.deliveryId,
  );
  const runs = new TaskRunService({
    log: f.store.log,
    clock: f.deps.clock,
    ids: { commandId: () => `cmd_${++id}`, eventId: () => `event_${++id}` },
  });
  let ownerPort: CodingApprovalOwnerPort = {
    decide: async () => 'allow-once',
  };
  const factory = codingTurnFactory({
    store: f.store.coding,
    evidence: f.store.codingEvidence,
    tasks: f.tasks,
    approvals: f.approvals,
    journal: f.store.tools,
    leases: f.deps.leases,
    sandbox: async (task) => {
      effects.qualifications++;
      return { root: task.worktreeRoot! };
    },
    inspectSandbox: async (task) => ({ root: task.worktreeRoot! }),
    owner: () => ownerPort,
  });
  return {
    ...f,
    claim,
    runs,
    factory,
    setOwner(value: CodingApprovalOwnerPort) {
      ownerPort = value;
    },
  };
}

export { settledRead } from './room-coding-invocation.js';

export { script, effects };
