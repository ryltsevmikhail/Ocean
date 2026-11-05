import { expect, it } from 'vitest';
import { InMemoryConversationStore } from '@runnets/store';
import type { CommandPayloads, CommandType, EventEnvelope } from '@runnets/domain';
import { executeStep, RoomModelExecutionReads } from './index.js';
import { activation, instant, setup } from '../test-fixtures/model-turn.js';

const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
async function fixture() {
  const input = await setup();
  const store = new InMemoryConversationStore();
  const bot = {
    id: 'bot',
    workspaceId: 'model_turn',
    handle: 'dev',
    name: 'Dev',
    role: 'fixture',
    provider: 'scripted',
    model: 'scripted',
    profileVersion: 1,
  };
  store.atomic((tx) => {
    tx.putWorkspace({ id: 'model_turn', root: '/fixture' });
    tx.putBot(bot);
    tx.putRoom({ id: 'room', workspaceId: 'model_turn', kind: 'direct', botId: bot.id });
    tx.putChatTurn({
      id: 'turn',
      workspaceId: 'model_turn',
      roomId: 'room',
      requestId: 'request',
      taskRunId: input.taskRunId,
      inboundMessageId: 'inbound',
      readThroughSeq: 1,
      bot,
      status: 'dispatching',
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
    });
  });
  async function step<T extends CommandType>(type: T, payload: CommandPayloads[T]) {
    const result = await executeStep(
      input.service,
      input.taskRunId,
      type,
      payload,
      (await input.service.state(input.taskRunId)).version,
    );
    if (!result.ok) throw result.error;
  }
  await step('Admit', {});
  await step('Schedule', {});
  await step('StartAttempt', {
    attemptId: 'attempt_a',
    reason: 'initial',
    provider: 'scripted',
    model: 'scripted',
  });
  const frozen = activation('optional');
  const start = (ordinal: number, attemptId = 'attempt_a') =>
    step('StartModelRequest', { attemptId, ordinal, activation: frozen, startedAt: instant });
  const settle = (
    ordinal: number,
    usage: CommandPayloads['SettleModelRequest']['usage'],
    attemptId = 'attempt_a',
  ) =>
    step('SettleModelRequest', {
      attemptId,
      ordinal,
      finishedAt: instant,
      completion: { kind: 'terminal', stopReason: 'stop' },
      usage,
    });
  const query = { workspaceId: 'model_turn', roomId: 'room', runId: input.taskRunId };
  return {
    ...input,
    store,
    step,
    start,
    settle,
    query,
    reads: new RoomModelExecutionReads({ store, tasks: input.service }),
  };
}

it('materializes a detached delayed pending prefix while the real committed head advances', async () => {
  const f = await fixture();
  await f.start(1);
  const prefix = structuredClone(await f.service.events(f.taskRunId));
  let release!: (events: readonly EventEnvelope[]) => void;
  const blocked = new Promise<readonly EventEnvelope[]>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const reads = new RoomModelExecutionReads({
    store: f.store,
    tasks: {
      events: async (id) => {
        calls++;
        return calls === 1 ? blocked : f.service.events(id);
      },
    },
  });
  const pending = reads.get(f.query);
  await f.settle(1, { kind: 'actual', tokens: zero });
  const head = (await f.service.state(f.taskRunId)).version;
  expect(head).toBeGreaterThan(prefix.length);
  release(prefix);
  const old = await pending;
  expect(old.runVersion).toBe(prefix.length);
  expect(old.execution).toMatchObject({
    lastRequest: { settlement: null },
    usage: {
      completeness: 'incomplete',
      requestCounts: { actual: 0, estimated: 0, unavailable: 0, pending: 1 },
    },
  });
  expect(calls).toBe(1);
  const current = await reads.get(f.query);
  expect(current.runVersion).toBe(head);
  expect(current.execution).toMatchObject({
    lastRequest: {
      settlement: { completion: { kind: 'terminal' }, usage: { kind: 'actual', tokens: zero } },
    },
    usage: {
      completeness: 'complete',
      requestCounts: { actual: 1, estimated: 0, unavailable: 0, pending: 0 },
    },
  });
  expect(calls).toBe(2);
});

it.each([false, true])(
  'keeps global ordinals and zero categories across real explicit attempts; legacy prefix %s',
  async (legacy) => {
    const f = await fixture();
    expect((await f.reads.get(f.query)).execution).toBeNull();
    if (legacy)
      await f.step('RecordUsage', {
        attemptId: 'attempt_a',
        usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
      });
    await f.start(1);
    await f.settle(1, { kind: 'estimated', tokens: zero, estimator: 'fixture' });
    await f.step('Retry', { attemptId: 'attempt_a', delayMs: 0, dueAt: instant });
    await f.step('StartAttempt', {
      attemptId: 'attempt_b',
      reason: 'retry',
      provider: 'scripted',
      model: 'scripted',
    });
    await f.start(2, 'attempt_b');
    await f.settle(2, { kind: 'actual', tokens: zero }, 'attempt_b');
    await f.start(3, 'attempt_b');
    await f.settle(3, { kind: 'unavailable', reason: 'not_reported' }, 'attempt_b');
    await f.start(4, 'attempt_b');
    const snapshot = await f.reads.get(f.query);
    expect(snapshot.runVersion).toBe((await f.service.state(f.taskRunId)).version);
    expect(snapshot.execution).toMatchObject({
      startedRequests: 4,
      lastRequest: { ordinal: 4, attemptId: 'attempt_b', settlement: null },
      usage: {
        completeness: 'incomplete',
        knownTokens: legacy ? 5 : 0,
        estimatedTokens: 0,
        unavailableRequests: 1,
        knownTokensScope: 'run_ledger_including_legacy_prefix',
        requestCounts: { actual: 1, estimated: 1, unavailable: 1, pending: 1 },
      },
    });
    const starts = (await f.service.events(f.taskRunId)).filter(
      (e) => e.type === 'attempt.model_request_started',
    );
    expect(starts.map((e) => (e.payload as { ordinal: number }).ordinal)).toEqual([1, 2, 3, 4]);
    expect(starts.map((e) => (e.payload as { attemptId: string }).attemptId)).toEqual([
      'attempt_a',
      'attempt_b',
      'attempt_b',
      'attempt_b',
    ]);
  },
);
