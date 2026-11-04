import { expect, it } from 'vitest';
import { InMemoryEventLog } from '@runnets/store';
import { executeStep } from './commands.js';
import { beginAttempt, settleUsage } from './lifecycle.js';
import { beginModelRequest, settleModelRequest } from './model-dispatch.js';
import { notSentRound, modelRound } from './round.js';
import { runTurn } from './turn.js';
import {
  activation,
  instant,
  provider,
  setup,
  terminal,
  usage,
} from '../test-fixtures/model-turn.js';

it('settles not_sent when cancellation arrives after durable start but before stream', async () => {
  const log = new InMemoryEventLog();
  const original = log.commands.commitWithDisposition!;
  const controller = new AbortController();
  log.commands.commitWithDisposition = async (...args) => {
    const result = await original(...args);
    if (args[0].type === 'StartModelRequest') controller.abort();
    return result;
  };
  const input = await setup([], undefined, log);
  let calls = 0;
  const result = await runTurn({
    ...input,
    signal: controller.signal,
    provider: {
      ...provider([]),
      stream() {
        calls++;
        throw Error('must not send');
      },
    },
  });
  expect(result.kind).toBe('cancelled');
  expect(calls).toBe(0);
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'cancelled',
    modelExecution: {
      lastRequest: {
        settlement: { completion: { kind: 'not_sent' }, usage: { kind: 'unavailable' } },
      },
    },
  });
  expect(
    (await input.service.events(input.taskRunId)).filter(
      (e) => e.type === 'attempt.usage_recorded',
    ),
  ).toHaveLength(0);
});
it('permits completed cleanup only after complete framing and no tool effects', async () => {
  const log = new InMemoryEventLog();
  const original = log.commands.commitWithDisposition!;
  const controller = new AbortController();
  log.commands.commitWithDisposition = async (...args) => {
    const result = await original(...args);
    if (args[0].type === 'SettleModelRequest') controller.abort();
    return result;
  };
  const input = await setup([usage, terminal], undefined, log);
  expect((await runTurn({ ...input, signal: controller.signal })).kind).toBe('cancelled');
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'cancelled',
    budget: { consumed: { provider_tokens: 2 } },
    modelExecution: { lastRequest: { settlement: { completion: { kind: 'terminal' } } } },
  });
});
it('refuses legacy non-atomic logs before external execution', async () => {
  const memory = new InMemoryEventLog();
  const input = await setup([], undefined, {
    load: memory.load.bind(memory),
    append: memory.append.bind(memory),
  });
  let calls = 0;
  const result = await runTurn({
    ...input,
    provider: {
      ...provider([]),
      stream() {
        calls++;
        throw Error('must not send');
      },
    },
  });
  expect(result.kind).toBe('failed');
  expect(result.text).toContain('atomic_commands_required');
  expect(calls).toBe(0);
});
it('uses the persisted next ordinal and original activation across a known nonexecution retry', async () => {
  const base = await setup();
  const input = { ...base, activation: activation() };
  const first = await beginAttempt(input);
  await beginModelRequest(input, first.attemptId, 1);
  await settleModelRequest(input, first.attemptId, 1, notSentRound());
  const state = await input.service.state(input.taskRunId);
  const retry = await executeStep(
    input.service,
    input.taskRunId,
    'Retry',
    { attemptId: first.attemptId, delayMs: 0, dueAt: instant },
    state.version,
  );
  if (!retry.ok) throw retry.error;
  const result = await runTurn({
    ...base,
    maxModelRequests: 2,
    clock: { now: () => new Date(Date.parse(instant) + 1) },
  });
  expect(result.kind).toBe('completed');
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    attemptCount: 2,
    modelExecution: {
      activation: activation(),
      startedRequests: 2,
      lastRequest: { ordinal: 2, attemptId: 'tr_model_turn_at_0002' },
    },
  });
});
it('does not double debit through legacy lifecycle settlement after journal settlement', async () => {
  const base = await setup();
  const input = { ...base, activation: activation() };
  const { attemptId } = await beginAttempt(input);
  await beginModelRequest(input, attemptId, 1);
  const round = await modelRound(input, []);
  await settleModelRequest(input, attemptId, 1, round);
  await settleUsage(input, attemptId, round.usage);
  expect(
    (await input.service.events(input.taskRunId)).filter(
      (e) => e.type === 'attempt.usage_recorded',
    ),
  ).toHaveLength(1);
});
it('does not execute from a replayed start disposition', async () => {
  const log = new InMemoryEventLog();
  const original = log.commands.commitWithDisposition!;
  log.commands.commitWithDisposition = async (...args) => {
    const result = await original(...args);
    return result.ok && args[0].type === 'StartModelRequest'
      ? { ok: true, value: { ...result.value, disposition: 'replayed' as const } }
      : result;
  };
  const input = await setup([], undefined, log);
  let calls = 0;
  expect(
    (
      await runTurn({
        ...input,
        provider: {
          ...provider([]),
          stream() {
            calls++;
            throw Error('must not send');
          },
        },
      })
    ).kind,
  ).toBe('uncertain');
  expect(calls).toBe(0);
  expect(await input.service.state(input.taskRunId)).toMatchObject({
    status: 'reconciling',
    modelExecution: { lastRequest: { settlement: null } },
  });
});
it('rejects changed start and settlement payloads under the original journal IDs', async () => {
  const base = await setup();
  const input = { ...base, activation: activation() };
  const { attemptId } = await beginAttempt(input);
  await beginModelRequest(input, attemptId, 1);
  await expect(
    beginModelRequest(
      {
        ...input,
        activation: {
          ...input.activation,
          capabilities: { ...input.activation.capabilities, usage: 'optional' },
        },
      },
      attemptId,
      1,
    ),
  ).rejects.toThrow('command id');
  const round = await modelRound(input, []);
  await settleModelRequest(input, attemptId, 1, round);
  await expect(
    settleModelRequest(input, attemptId, 1, {
      ...round,
      usageEvidence: { kind: 'unavailable', reason: 'not_reported' },
    }),
  ).rejects.toThrow('command id');
});

it('does not journal a model request if cancellation arrives before start admission', async () => {
  const log = new InMemoryEventLog();
  const input = await setup([], undefined, log);
  const controller = new AbortController();
  const original = log.load.bind(log);
  let afterStartReads = 0;
  log.load = async (id) => {
    const events = await original(id);
    if (events.some((e) => e.type === 'attempt.started') && ++afterStartReads === 3) {
      controller.abort();
    }
    return events;
  };
  let calls = 0;
  expect(
    (
      await runTurn({
        ...input,
        signal: controller.signal,
        provider: {
          ...provider([]),
          stream() {
            calls++;
            throw Error('must not send');
          },
        },
      })
    ).kind,
  ).toBe('cancelled');
  expect(calls).toBe(0);
  expect(
    (await input.service.events(input.taskRunId)).some(
      (e) => e.type === 'attempt.model_request_started',
    ),
  ).toBe(false);
});
