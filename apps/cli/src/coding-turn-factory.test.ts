import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type * as Platform from '@runnets/tools-node';
import type { ChatTurn, CodingApprovalBinding } from '@runnets/domain';
import {
  CodingTaskService,
  type CodingServiceDeps,
  type PreparedCodingOperation,
} from '@runnets/application';
import { consumerFinalization } from '../../../packages/store-sqlite/test-fixtures/coding-consumer-finalization.js';
import { consumerFixture } from '../../../packages/store-sqlite/test-fixtures/coding-consumer.js';
import { codingTurnFactory } from './coding-turn-factory.js';
const script = vi.hoisted(() => ({
  effects: [] as string[],
  reads: 0,
  prepare: async () => {},
  current: async () => {},
  dispatch: () => {},
}));
// Only the qualified platform session is scripted; task, approval, grant and journal are real.
vi.mock('@runnets/tools-node', async (original) => ({
  ...(await original<typeof Platform>()),
  createCodingOperationSession: async (
    input: Parameters<typeof Platform.createCodingOperationSession>[0],
  ) => ({
    read: async () => {
      script.reads++;
      return { output: 'project instructions', isError: false };
    },
    prepare: async (
      id: string,
      call: { id: string; name: string; arguments: string },
      attemptId: string,
    ): Promise<PreparedCodingOperation> => {
      await script.prepare();
      const operation = call.name === 'run_command' ? 'test' : 'write';
      const binding: CodingApprovalBinding = {
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
      };
      return {
        approvalId: id,
        binding,
        guarded: true,
        currentBinding: async () => {
          await script.current();
          return binding;
        },
        tool: {
          title: operation,
          kind: operation === 'test' ? 'execute' : 'edit',
          preview: operation === 'test' ? call.arguments : 'exact edit',
          execute: async (_signal, guard) => {
            script.dispatch();
            if (!guard?.authorize()) throw Error('dispatch refused');
            script.effects.push(operation);
            return { output: operation + ' result', isError: false };
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
                  output: 'test result',
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
  }),
}));
const fixtures: ReturnType<typeof consumerFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  script.effects = [];
  script.reads = 0;
  script.prepare = async () => {};
  script.current = async () => {};
  script.dispatch = () => {};
});
function setup(overrides: Partial<CodingServiceDeps> = {}) {
  const f = consumerFixture();
  fixtures.push(f);
  let prompts = 0;
  let ownerHook = async () => {};
  let qualifyHook = async () => {};
  const factory = codingTurnFactory({
    store: f.store.coding,
    evidence: f.store.codingEvidence,
    tasks: new CodingTaskService({ ...f.deps, ...overrides }),
    approvals: f.approvals,
    journal: f.store.tools,
    sandbox: async (task) => {
      await qualifyHook();
      return { root: task.worktreeRoot! };
    },
    inspectSandbox: async (task) => ({ root: task.worktreeRoot! }),
    owner: () => ({
      decide: async () => {
        prompts++;
        await ownerHook();
        return 'allow-once';
      },
    }),
  });
  const turn: ChatTurn = {
    id: 'turn-b',
    codingTaskId: f.b.id,
    workspaceId: 'ws',
    roomId: 'room',
    requestId: 'request-b',
    taskRunId: 'run-b',
    inboundMessageId: 'inbound',
    readThroughSeq: 0,
    bot: f.store.conversations.atomic((tx) => tx.bot('dev'))!,
    status: 'accepted',
    text: 'work',
    preparedVersion: null,
    stopReason: 'end_turn',
  };
  return {
    ...f,
    factory,
    turn,
    prompts: () => prompts,
    ownerHook: (hook: typeof ownerHook) => {
      ownerHook = hook;
    },
    qualifyHook: (hook: typeof qualifyHook) => {
      qualifyHook = hook;
    },
  };
}
it('normal factory reads, edits and runs a registered preset under B grant while A remains uncertain', async () => {
  const f = setup();
  await f.uncertainA();
  f.grant();
  const aBefore = f.aRows();
  const tools = await f.factory.forTurn(f.turn, new AbortController().signal);
  for (const [id, name, args] of [
    ['read', 'read_file', { path: 'README.md' }],
    ['edit', 'write_file', { path: 'file', content: 'after' }],
    ['test', 'run_test', { presetId: 'test' }],
  ] as const) {
    expect(
      await tools.execute(
        { id, name, arguments: JSON.stringify(args) },
        new AbortController().signal,
        { taskRunId: 'run-b', attemptId: 'attempt-b' },
      ),
    ).toMatchObject({ isError: false });
  }
  expect(script.reads).toBe(1);
  expect(script.effects).toEqual(['write', 'test']);
  expect(f.prompts()).toBe(0);
  expect(f.sends()).toBe(1);
  expect(f.aRows()).toEqual(aBefore);
  expect(aBefore.calls).toBe(1);
  expect(f.store.finalization.atomic((tx) => tx.holds(f.b.id))).toEqual([]);
  const aHolds = f.holds();
  const { service, owner, selection, released } = consumerFinalization(f);
  try {
    const card = await service.preview(selection, new AbortController().signal);
    await owner.resolve(card, card.bindingDigest, card.version, 'allow-once');
    await service.join();
    expect(service.result(selection)).toMatchObject({
      state: 'finalized',
      taskStatus: 'finalized',
    });
    expect(released).toEqual([f.b.id]);
    expect(f.aRows()).toEqual(aBefore);
    expect(f.holds()).toEqual(aHolds);
  } finally {
    await service.close();
  }
});
it.each([
  ['same-task', 'task'],
  ['wrong-tool', 'task-b'],
])('normal factory refuses %s with zero platform effects', async (mode, codingTaskId) => {
  const f = setup();
  await f.uncertainA();
  if (mode === 'wrong-tool') f.db.exec("UPDATE tool_invocations_v2 SET tool='command'");
  await expect(
    f.factory.forTurn({ ...f.turn, codingTaskId }, new AbortController().signal),
  ).rejects.toThrow();
  expect(script.effects).toEqual([]);
  expect(f.prompts()).toBe(0);
});

it.each(['lease', 'restored', 'review'] as const)(
  'normal factory refuses %s admission',
  async (mode) => {
    const f = setup(mode === 'restored' ? { restored: true } : {});
    await f.uncertainA();
    f.grant();
    if (mode === 'lease') f.live.delete('worktree-b');
    const turn =
      mode === 'review'
        ? {
            ...f.turn,
            roomId: 'review-room',
            bot: f.store.conversations.atomic((tx) => tx.bot('review'))!,
          }
        : f.turn;
    await expect(f.factory.forTurn(turn, new AbortController().signal)).rejects.toThrow();
    expect(script.effects).toEqual([]);
    expect(f.prompts()).toBe(0);
  },
);
it.each([
  'qualification',
  'before-call',
  'prepare',
  'owner',
  'binding',
  'revoke',
  'dispatch-lease',
] as const)(
  'rechecks a late %s change through the normal factory and per-call dispatch',
  async (phase) => {
    const f = setup();
    await f.uncertainA();
    if (phase !== 'owner') f.grant();
    const conflict = () =>
      f.db.exec("INSERT INTO tool_invocations_v1 VALUES('late','command','uncertain')");
    if (phase === 'qualification') {
      f.qualifyHook(async () => {
        conflict();
      });
      await expect(f.factory.forTurn(f.turn, new AbortController().signal)).rejects.toThrow();
    } else {
      const tools = await f.factory.forTurn(f.turn, new AbortController().signal);
      if (phase === 'before-call') conflict();
      if (phase === 'prepare')
        script.prepare = async () => {
          conflict();
        };
      if (phase === 'owner')
        f.ownerHook(async () => {
          conflict();
        });
      if (phase === 'binding')
        script.current = async () => {
          conflict();
        };
      if (phase === 'revoke')
        script.dispatch = () => {
          f.owners.revoke({ grantId: 'grant-task-b', revision: 1 });
        };
      if (phase === 'dispatch-lease')
        script.dispatch = () => {
          f.live.delete('worktree-b');
        };
      expect(
        await tools.execute(
          { id: 'edit', name: 'write_file', arguments: '{"path":"file","content":"after"}' },
          new AbortController().signal,
          { taskRunId: 'run-b', attemptId: 'attempt-b' },
        ),
      ).toMatchObject({ isError: true });
    }
    expect(script.effects).toEqual([]);
    expect(f.sends()).toBe(1);
    expect(f.prompts()).toBe(phase === 'owner' ? 1 : 0);
  },
);
