import { expect, it, vi } from 'vitest';
import type { ProviderEvent } from './provider.js';
import { InMemoryEventLog } from '@runnets/store';
import { normalizeModelActivation } from './model-activation.js';
import { beginModelRequest, settleModelRequest } from './model-dispatch.js';
import { beginAttempt } from './lifecycle.js';
import { modelRound } from './round.js';
import { runTurn } from './turn.js';
import {
  activation,
  instant,
  provider,
  setup,
  terminal,
  usage,
} from '../test-fixtures/model-turn.js';

it('normalizes injected/ACP hosts conservatively without a connection revision', async () => {
  const input = await setup();
  const snapshot = normalizeModelActivation(input);
  expect(snapshot.identity).toEqual({
    source: 'host',
    providerId: 'scripted',
    modelId: 'scripted',
  });
  expect(snapshot.limits.maxModelRequests).toBe(24);
  expect(snapshot.capabilities.usage).toBe('reported');
  expect(
    normalizeModelActivation({ ...input, maxModelRequests: 100 }).limits.maxModelRequests,
  ).toBe(64);
  expect(
    normalizeModelActivation({ ...input, maxModelRequests: 2.9 }).limits.maxModelRequests,
  ).toBe(2);
  expect(() => normalizeModelActivation({ ...input, maxModelRequests: NaN })).toThrow();
});
it('keeps deterministic provider-null turns outside the model journal', async () => {
  const input = await setup();
  expect((await runTurn({ ...input, provider: null })).kind).toBe('completed');
  expect(
    (await input.service.events(input.taskRunId)).some((e) =>
      e.type.startsWith('attempt.model_request'),
    ),
  ).toBe(false);
});
it('commits start before streaming and settlement before completing', async () => {
  const input = await setup();
  let started = false;
  const port = {
    ...provider([]),
    async *stream() {
      started = (await input.service.events(input.taskRunId)).some(
        (e) => e.type === 'attempt.model_request_started',
      );
      yield usage;
      yield terminal;
    },
  };
  expect((await runTurn({ ...input, provider: port })).kind).toBe('completed');
  expect(started).toBe(true);
  const types = (await input.service.events(input.taskRunId)).map((e) => e.type);
  expect(types.indexOf('attempt.model_request_settled')).toBeLessThan(
    types.indexOf('task_run.succeeded'),
  );
});
it('reconstructs the exact first start on retry without reauthorizing a stream', async () => {
  const base = await setup();
  const input = { ...base, activation: activation() };
  const { attemptId } = await beginAttempt(input);
  expect(await beginModelRequest(input, attemptId, 1)).toBe('dispatch');
  const later = { ...input, clock: { now: () => new Date(Date.parse(instant) + 10) } };
  expect(await beginModelRequest(later, attemptId, 1)).toBe('replayed');
  const round = await modelRound(input, []);
  await settleModelRequest(input, attemptId, 1, round);
  await settleModelRequest(later, attemptId, 1, round);
  expect(
    (await input.service.events(input.taskRunId)).filter(
      (e) => e.type === 'attempt.model_request_settled',
    ),
  ).toHaveLength(1);
});
it('does not send or claim cleanup after a lost start receipt', async () => {
  const log = new InMemoryEventLog();
  const original = log.commands.commitWithDisposition!;
  log.commands.commitWithDisposition = async (...args) => {
    const result = await original(...args);
    if (args[0].type === 'StartModelRequest') throw Error('receipt lost');
    return result;
  };
  const input = await setup([], undefined, log);
  let calls = 0;
  const outcome = await runTurn({
    ...input,
    provider: {
      ...provider([]),
      stream() {
        calls++;
        throw Error('must not send');
      },
    },
  });
  expect(outcome.kind).toBe('uncertain');
  expect(calls).toBe(0);
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'reconciling',
    modelExecution: { lastRequest: { settlement: null } },
  });
});
it('bounds a pending next that ignores abort and ignores late output/return', async () => {
  vi.useFakeTimers();
  try {
    const input = await setup();
    let resolve!: (event: IteratorResult<ProviderEvent>) => void;
    let entered!: () => void;
    const dispatched = new Promise<void>((r) => {
      entered = r;
    });
    const pending = new Promise<IteratorResult<ProviderEvent>>((r) => {
      resolve = r;
    });
    const updates: unknown[] = [];
    const port = {
      ...provider([]),
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                entered();
                return pending;
              },
              return() {
                return new Promise<IteratorResult<ProviderEvent>>(() => {});
              },
            };
          },
        };
      },
    };
    const snapshot = activation();
    const running = runTurn({
      ...input,
      activation: { ...snapshot, limits: { ...snapshot.limits, requestTimeoutMs: 10 } },
      provider: port,
      emit: (u) => updates.push(u),
    });
    await dispatched;
    await vi.advanceTimersByTimeAsync(11);
    expect((await running).kind).toBe('uncertain');
    const before = await input.service.events(input.taskRunId);
    expect(await input.service.state(input.taskRunId)).toMatchObject({
      status: 'reconciling',
      modelExecution: { lastRequest: { settlement: { completion: { kind: 'unknown' } } } },
    });
    const updateCount = updates.length;
    resolve({ done: false, value: { type: 'text_delta', text: 'late' } });
    await vi.runAllTimersAsync();
    expect(await input.service.events(input.taskRunId)).toEqual(before);
    expect(updates).toHaveLength(updateCount);
    expect(before.filter((e) => e.type === 'attempt.model_request_settled')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
