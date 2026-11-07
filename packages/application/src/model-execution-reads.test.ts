import { InMemoryConversationStore } from '@runnets/store';
import { expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@runnets/domain';
import * as app from './index.js';
import { policyFixture } from '../test-fixtures/room-model-policy.js';
import { setup, terminal, usage } from '../test-fixtures/model-turn.js';
import { runTurn } from './turn.js';

async function fixture() {
  const original = policyFixture();
  const store = new InMemoryConversationStore();
  for (const row of original.connections.list())
    store.put(row, store.read(row.connectionId)?.revision ?? null);
  const f = {
    ...original,
    store,
    room: { ...original.room, workspaceId: 'work' },
    bot: { ...original.bot, workspaceId: 'work' },
    service: new app.BotModelBindingService({
      store,
      connections: store,
      factory: original.factory,
      nextId: () => 'unused',
    }),
  };
  // The real producer brands ws_<workspace>; its suffix must have at least three chars.
  store.atomic((tx) => {
    tx.putWorkspace({ id: 'work', root: '/project' });
    tx.putBot(f.bot);
    tx.putRoom(f.room);
  });
  const input = await setup([usage, terminal]);
  await runTurn(input);
  const stream = (await input.service.events(input.taskRunId)).map((event) =>
    event.type === 'task_run.created'
      ? { ...event, payload: { ...(event.payload as object), workspaceId: 'ws_work' } }
      : event,
  );
  f.store.atomic((tx) =>
    tx.putChatTurn({
      id: 'turn',
      workspaceId: 'work',
      roomId: f.room.id,
      requestId: 'request',
      taskRunId: input.taskRunId,
      inboundMessageId: 'message',
      readThroughSeq: 1,
      bot: f.bot,
      status: 'completed',
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
    }),
  );
  const events = vi.fn(async () => structuredClone(stream) as readonly EventEnvelope[]);
  const reads = new app.RoomModelExecutionReads({ store: f.store, tasks: { events } });
  return {
    ...f,
    input,
    stream,
    events,
    reads,
    query: { workspaceId: 'work', roomId: f.room.id, runId: input.taskRunId },
  };
}
const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
it.each(['actual', 'estimated', 'unavailable'] as const)(
  'distinguishes %s zero usage from request completion',
  async (kind) => {
    const f = await fixture();
    f.events.mockImplementation(async () =>
      f.stream.map((event) =>
        event.type === 'attempt.model_request_settled'
          ? {
              ...event,
              payload: {
                ...(event.payload as object),
                completion: { kind: 'unknown' },
                usage:
                  kind === 'unavailable'
                    ? { kind, reason: 'not_reported' }
                    : kind === 'estimated'
                      ? { kind, tokens: zero, estimator: 'test' }
                      : { kind, tokens: zero },
              },
            }
          : event,
      ),
    );
    const result = await f.reads.get(f.query);
    expect(result.execution?.usage).toMatchObject({
      scope: 'recorded_model_requests',
      completeness: kind === 'actual' ? 'complete' : 'incomplete',
      requestCounts: {
        actual: kind === 'actual' ? 1 : 0,
        estimated: kind === 'estimated' ? 1 : 0,
        unavailable: kind === 'unavailable' ? 1 : 0,
        pending: 0,
      },
    });
    expect(result.execution?.lastRequest.settlement?.completion).toEqual({ kind: 'unknown' });
    expect(result.runVersion).toBe(f.stream.length);
    expect(f.events).toHaveBeenCalledTimes(1);
  },
);
it('checks scope before the journal and returns no-record legacy state explicitly', async () => {
  const f = await fixture();
  await expect(f.reads.get({ ...f.query, roomId: 'foreign' })).rejects.toThrow('unknown_run');
  expect(f.events).not.toHaveBeenCalled();
  const legacy = f.stream
    .filter((e) => !e.type.startsWith('attempt.model_request'))
    .map((e, n) => ({ ...e, sequence: n + 1 }));
  f.events.mockResolvedValue(legacy);
  expect((await f.reads.get(f.query)).execution).toBeNull();
});
it('reports pending and missing request-category reconstruction separately', async () => {
  const f = await fixture();
  const starts = f.stream
    .filter((e) => e.type !== 'attempt.model_request_settled')
    .map((e, n) => ({ ...e, sequence: n + 1 }));
  f.events.mockResolvedValue(starts);
  expect((await f.reads.get(f.query)).execution?.usage).toMatchObject({
    completeness: 'incomplete',
    requestCounts: { pending: 1 },
  });
  f.events.mockResolvedValue(
    starts.map((e) =>
      e.type === 'attempt.model_request_started'
        ? { ...e, payload: { ...(e.payload as object), ordinal: 2 } }
        : e,
    ),
  );
  expect((await f.reads.get(f.query)).execution?.usage).toMatchObject({
    completeness: 'unknown',
    requestCounts: null,
  });
});

it('retains estimated-zero evidence after later actual usage and rejects duplicate category proof', async () => {
  const f = await fixture();
  const start = f.stream.find((e) => e.type === 'attempt.model_request_started')!;
  const settled = f.stream.find((e) => e.type === 'attempt.model_request_settled')!;
  const first = f.stream.map((e) =>
    e === settled
      ? {
          ...e,
          payload: {
            ...(e.payload as object),
            usage: { kind: 'estimated', tokens: zero, estimator: 'test' },
          },
        }
      : e,
  );
  const extra = [
    { ...start, payload: { ...(start.payload as object), ordinal: 2 } },
    {
      ...settled,
      payload: {
        ...(settled.payload as object),
        ordinal: 2,
        usage: { kind: 'actual', tokens: zero },
      },
    },
  ];
  const stream = [...first, ...extra].map((e, n) => ({ ...e, sequence: n + 1 }));
  f.events.mockResolvedValue(stream);
  expect((await f.reads.get(f.query)).execution?.usage).toMatchObject({
    completeness: 'incomplete',
    estimatedTokens: 0,
    requestCounts: { actual: 1, estimated: 1, unavailable: 0, pending: 0 },
  });
  f.events.mockResolvedValue([...stream, { ...extra[1]!, sequence: stream.length + 1 }]);
  expect((await f.reads.get(f.query)).execution?.usage).toMatchObject({
    completeness: 'unknown',
    requestCounts: null,
  });
});

it('returns frozen admitted connection identity and closed evidence after current bot rebinding', async () => {
  const f = await fixture();
  const admitted = {
    source: 'connection',
    connectionId: 'original',
    modelId: 'frozen',
    providerId: 'fixture',
    connectionRevision: 3,
    botProfileVersion: 2,
    kind: 'local',
    endpoint: 'http://127.0.0.1:8080',
    auth: 'none',
    artifactDigest: null,
    backendVersion: null,
  };
  f.events.mockResolvedValue(
    f.stream.map((event) => {
      if (event.type !== 'attempt.model_request_started') return event;
      const p = event.payload as { activation: object };
      return {
        ...event,
        payload: {
          ...(event.payload as object),
          activation: {
            ...p.activation,
            identity: { ...admitted, privateCredential: 'DO_NOT_EXPORT' },
          },
          rawPayload: 'DO_NOT_EXPORT',
        },
      };
    }),
  );
  f.service.set({
    workspaceId: 'work',
    requestId: 'new-binding',
    botId: f.bot.id,
    expectedProfileVersion: 1,
    binding: { connectionId: 'shared', modelId: 'two' },
  });
  const snapshot = await f.reads.get(f.query);
  expect(snapshot.execution?.identity).toEqual({
    source: 'connection',
    connectionId: 'original',
    modelId: 'frozen',
    providerId: 'fixture',
    connectionRevision: 3,
    botProfileVersion: 2,
    kind: 'local',
  });
  expect(JSON.stringify(snapshot)).not.toMatch(
    /DO_NOT_EXPORT|endpoint|artifactDigest|privateCredential|rawPayload/,
  );
});

it('refuses malformed model discriminants and noncontiguous journals with sanitized errors', async () => {
  const f = await fixture();
  f.events.mockResolvedValue(
    f.stream.map((event) =>
      event.type === 'attempt.model_request_settled'
        ? {
            ...event,
            payload: { ...(event.payload as object), usage: { kind: ['actual'], tokens: zero } },
          }
        : event,
    ),
  );
  await expect(f.reads.get(f.query)).rejects.toThrow('model_execution_unavailable');
  f.events.mockResolvedValue(
    f.stream.map((event, n) => (n === 0 ? { ...event, sequence: 2 } : event)),
  );
  await expect(f.reads.get(f.query)).rejects.toThrow('model_execution_unavailable');
});

it('labels a legacy usage prefix without claiming whole-run billing completeness', async () => {
  const f = await fixture();
  const startIndex = f.stream.findIndex((e) => e.type === 'attempt.model_request_started');
  const ledger = f.stream.find((e) => e.type === 'attempt.usage_recorded')!;
  const prefix = {
    ...ledger,
    payload: {
      attemptId: (ledger.payload as { attemptId: string }).attemptId,
      usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
    },
  };
  const stream = [...f.stream.slice(0, startIndex), prefix, ...f.stream.slice(startIndex)].map(
    (e, n) => ({ ...e, sequence: n + 1 }),
  );
  f.events.mockResolvedValue(stream);
  expect((await f.reads.get(f.query)).execution?.usage).toMatchObject({
    knownTokens: 7,
    knownTokensScope: 'run_ledger_including_legacy_prefix',
    scope: 'recorded_model_requests',
    completeness: 'complete',
    requestCounts: { actual: 1 },
  });
});

it.each(['work', 'ws_ws_work', 'ws_foreign', ['ws_work'], { id: 'ws_work' }])(
  'refuses a journal outside the exact host workspace mapping: %j',
  async (workspaceId) => {
    const f = await fixture();
    f.events.mockResolvedValue(
      f.stream.map((event) =>
        event.type === 'task_run.created'
          ? { ...event, payload: { ...(event.payload as object), workspaceId } }
          : event,
      ),
    );
    await expect(f.reads.get(f.query)).rejects.toThrow('model_execution_unavailable');
    expect(f.events).toHaveBeenCalledTimes(1);
  },
);
