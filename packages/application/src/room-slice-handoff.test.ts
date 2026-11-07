import { DomainError } from '@runnets/domain';
import { expect, expectTypeOf, it, vi } from 'vitest';
import { executeStep } from './commands.js';
import { combineChatTools } from './chat-turn-tools.js';
import { runTurn } from './turn.js';
import type { TurnInput, TurnOutcome, YieldedRoomSlice } from './types.js';
import { committedRoomDelegate, roomHandoffOf } from './room-slice-handoff.js';
import { provider } from '../test-fixtures/model-turn.js';
import { harness, successes, toolRound } from '../test-fixtures/room-slice-handoff.js';

it('finalizes the proven local slice, skips the suffix and resolves without a child or final answer', async () => {
  const h = await harness(committedRoomDelegate);
  const outcome = await runTurn(h.input, { turnId: 'turn_a' });
  expect(outcome).toEqual({ kind: 'yielded', handoff: h.proof() });
  expect(h.invoked).toEqual(['delegate']);
  expect(h.beforeComplete).not.toHaveBeenCalled();
  expect(h.history.map((m) => [m.role, m.toolCallId, m.content])).toEqual([
    ['assistant', undefined, ''],
    ['tool', 'delegate', 'Room delegation committed'],
    ['tool', 'physical', 'Not executed: delegated'],
  ]);
  const events = await h.input.service.events(h.input.taskRunId);
  expect(events.filter((e) => e.type === 'attempt.model_request_started')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'attempt.model_request_settled')).toHaveLength(1);
  expect(await successes(h.input)).toMatchObject([
    {
      sequence: h.proof().expectedRunVersion + 1,
      causationId: 'room-handoff-complete/v1:turn_a',
      actor: { kind: 'runtime', id: 'runne' },
      payload: { attemptId: h.proof().attemptId, summary: 'Room delegation committed' },
    },
  ]);
  expect(
    await h.input.service.lookupCommand({
      type: 'Complete',
      commandId: 'room-handoff-complete/v1:turn_a',
      taskRunId: h.input.taskRunId,
      actor: { kind: 'runtime', id: 'runne' },
      expectedVersion: h.proof().expectedRunVersion,
      payload: { attemptId: h.proof().attemptId, summary: 'Room delegation committed' },
    }),
  ).toMatchObject({ ok: true, value: { version: 8 } });
  expect(await h.input.service.state(h.input.taskRunId)).toMatchObject({
    status: 'succeeded',
    activeAttempt: { attemptId: h.proof().attemptId },
    terminal: { summary: 'Room delegation committed' },
  });
});

it.each(['text', 'json', 'clone', 'send', 'error'] as const)(
  'keeps ordinary %s results serial and allows a normal answer',
  async (mode) => {
    const firstTool = mode === 'send' ? 'local_send' : 'delegate';
    const h = await harness(committedRoomDelegate, firstTool);
    h.use((proof) =>
      mode === 'clone'
        ? { ...committedRoomDelegate(proof) }
        : {
            isError: mode === 'error',
            output:
              mode === 'json'
                ? JSON.stringify({ kind: 'delegated', handoff: proof })
                : 'Room delegation committed',
            kind: 'delegated',
            handoff: proof,
          },
    );
    expect(await runTurn(h.input, { turnId: 'turn_a' })).toEqual({
      kind: 'completed',
      stopReason: 'end_turn',
      text: 'answer',
    });
    expect(h.invoked).toEqual([firstTool, 'physical']);
    expect(h.starts()).toBe(2);
    expect(h.beforeComplete).toHaveBeenCalledOnce();
    expect(() => combineChatTools(h.source('delegate'), h.source('delegate'))).toThrow(
      'duplicate_tool_name',
    );
  },
);

it.each(['run', 'attempt', 'call', 'turn', 'stale', 'host'] as const)(
  'fences a genuine carrier with conflicting %s',
  async (mode) => {
    const h = await harness(committedRoomDelegate);
    h.use((proof) =>
      committedRoomDelegate({
        ...proof,
        ...(mode === 'run' ? { taskRunId: 'tr_other' } : {}),
        ...(mode === 'attempt' ? { attemptId: 'other_attempt' } : {}),
        ...(mode === 'call' ? { callId: 'other_call' } : {}),
        ...(mode === 'turn' ? { turnId: 'other_turn' } : {}),
        ...(mode === 'stale' ? { expectedRunVersion: proof.expectedRunVersion - 1 } : {}),
      }),
    );
    const outcome =
      mode === 'host' ? await runTurn(h.input) : await runTurn(h.input, { turnId: 'turn_a' });
    expect(outcome.kind).toBe('uncertain');
    expect(h.invoked).toEqual(['delegate']);
    expect(h.starts()).toBe(1);
    expect(await successes(h.input)).toHaveLength(0);
    expect(h.beforeComplete).not.toHaveBeenCalled();
    expect(h.history.at(-1)).toMatchObject({
      toolCallId: 'physical',
      content: 'Not executed: delegated',
    });
  },
);

it.each(['throw', 'unknown'] as const)(
  'stops on a first tool %s even with forged handoff fields',
  async (mode) => {
    const h = await harness(committedRoomDelegate);
    h.use((proof) => {
      if (mode === 'throw') throw Error('lost tool response');
      return {
        isError: false,
        uncertain: true,
        output: 'Room delegation committed',
        kind: 'delegated',
        handoff: proof,
      };
    });
    expect((await runTurn(h.input, { turnId: 'turn_a' })).kind).toBe('uncertain');
    expect(h.invoked).toEqual(['delegate']);
    expect(h.starts()).toBe(1);
    expect(await successes(h.input)).toHaveLength(0);
  },
);

it('does not admit a tool after unknown model settlement', async () => {
  const h = await harness(committedRoomDelegate);
  const input = { ...h.input, provider: provider(toolRound.slice(0, -1)) };
  expect((await runTurn(input, { turnId: 'turn_a' })).kind).toBe('uncertain');
  expect(h.invoked).toEqual([]);
  expect(await successes(input)).toHaveLength(0);
});
it('does not admit a tool after a lost settlement response', async () => {
  const h = await harness(committedRoomDelegate);
  const original = h.log.commands.commitWithDisposition!;
  h.log.commands.commitWithDisposition = async (...args) => {
    const committed = await original(...args);
    if (args[0].type === 'SettleModelRequest') throw Error('lost settlement');
    return committed;
  };
  expect((await runTurn(h.input, { turnId: 'turn_a' })).kind).toBe('uncertain');
  expect(h.invoked).toEqual([]);
  expect(await successes(h.input)).toHaveLength(0);
});
it('does not admit after a signal before tool invocation', async () => {
  const h = await harness(committedRoomDelegate);
  const input = {
    ...h.input,
    provider: {
      ...provider([]),
      async *stream() {
        yield* toolRound;
        h.abort.abort();
      },
    },
  };
  expect((await runTurn(input, { turnId: 'turn_a' })).kind).toBe('cancelled');
  expect(h.invoked).toEqual([]);
  expect(await successes(input)).toHaveLength(0);
});
it.each([false, true])(
  'records a known handoff before signal, committed cancellation=%s',
  async (cancel) => {
    const h = await harness(committedRoomDelegate);
    const { service, taskRunId } = h.input;
    h.use(async (proof) => {
      const carrier = committedRoomDelegate(proof);
      h.abort.abort();
      if (cancel) {
        const cancelled = await executeStep(
          service,
          taskRunId,
          'RequestCancel',
          { cause: 'cancel' },
          proof.expectedRunVersion,
        );
        expect(cancelled.ok).toBe(true);
      }
      return carrier;
    });
    expect((await runTurn(h.input, { turnId: 'turn_a' })).kind).toBe(
      cancel ? 'uncertain' : 'yielded',
    );
    expect(await successes(h.input)).toHaveLength(cancel ? 0 : 1);
    expect(h.invoked).toEqual(['delegate']);
    expect(h.starts()).toBe(1);
  },
);

it.each([
  'lost',
  'missing',
  'conflict',
  'version',
  'payload',
  'actor',
  'causation',
  'aggregate',
  'sequence',
  'extra',
  'head',
  'rejection',
  'disposition',
] as const)('requires exact completion receipt and head: %s', async (mode) => {
  const h = await harness(committedRoomDelegate);
  const execute = h.input.service.executeWithDisposition.bind(h.input.service);
  const lookup = vi.spyOn(h.input.service, 'lookupCommand');
  vi.spyOn(h.input.service, 'executeWithDisposition').mockImplementation(async (command) => {
    const committed = await execute(command);
    if (command.type !== 'Complete' || !committed.ok) return committed;
    if (mode === 'lost' || mode === 'missing' || mode === 'conflict') {
      if (mode === 'missing') lookup.mockResolvedValue({ ok: true, value: null });
      if (mode === 'conflict')
        lookup.mockResolvedValue({ ok: false, error: DomainError.invalidArgument('conflict') });
      throw Error('lost completion reply');
    }
    if (mode === 'rejection') return { ok: false, error: DomainError.invalidArgument('rejected') };
    if (mode === 'disposition')
      return { ok: true, value: { ...committed.value, disposition: 'unknown' as never } };
    const receipt = committed.value.receipt;
    const event = receipt.events[0]!;
    if (event.type !== 'task_run.succeeded') throw Error('expected success');
    const state = await h.input.service.state(h.input.taskRunId);
    if (state.status === 'absent') throw Error('missing run');
    if (mode === 'head')
      vi.spyOn(h.input.service, 'state').mockResolvedValue({
        ...state,
        version: receipt.version + 1,
      });
    return {
      ok: true,
      value: {
        ...committed.value,
        receipt: {
          ...receipt,
          ...(mode === 'version' ? { version: receipt.version + 1 } : {}),
          events:
            mode === 'extra'
              ? [event, event]
              : [
                  {
                    ...event,
                    ...(mode === 'payload'
                      ? { payload: { attemptId: 'wrong', summary: 'Room delegation committed' } }
                      : {}),
                    ...(mode === 'actor'
                      ? { actor: { kind: 'runtime' as const, id: 'wrong' } }
                      : {}),
                    ...(mode === 'causation' ? { causationId: 'wrong' } : {}),
                    ...(mode === 'aggregate' ? { aggregateId: 'wrong' } : {}),
                    ...(mode === 'sequence' ? { sequence: event.sequence + 1 } : {}),
                  },
                ],
        },
      },
    };
  });
  expect((await runTurn(h.input, { turnId: 'turn_a' })).kind).toBe(
    mode === 'lost' ? 'yielded' : 'uncertain',
  );
  expect(h.starts()).toBe(1);
  expect(h.invoked).toEqual(['delegate']);
  expect(await successes(h.input)).toHaveLength(1);
  expect(lookup).toHaveBeenCalledTimes(['lost', 'missing', 'conflict'].includes(mode) ? 1 : 0);
});

expectTypeOf<Awaited<ReturnType<typeof runTurn>>>().toEqualTypeOf<TurnOutcome>();
const _ordinary = (input: TurnInput) => runTurn(input);
const _room = (input: TurnInput) => runTurn(input, { turnId: 'turn_a' });
expectTypeOf<Awaited<ReturnType<typeof _ordinary>>>().toEqualTypeOf<TurnOutcome>();
expectTypeOf<Awaited<ReturnType<typeof _room>>>().toEqualTypeOf<TurnOutcome | YieldedRoomSlice>();
const acp = (outcome: Awaited<ReturnType<typeof runTurn>>) => outcome.stopReason;
expectTypeOf(acp).returns.toEqualTypeOf<TurnOutcome['stopReason']>();
it('validates bounded proof primitives and detaches a frozen exact-object association', () => {
  const proof = {
    turnId: 'turn',
    taskRunId: 'run',
    attemptId: 'attempt',
    callId: 'call',
    childTaskId: 'child',
    deliveryId: 'delivery',
    expectedRunVersion: 1,
  };
  const carrier = committedRoomDelegate(proof);
  proof.turnId = 'changed';
  expect(roomHandoffOf(carrier)?.turnId).toBe('turn');
  expect([carrier, roomHandoffOf(carrier)].every(Object.isFrozen)).toBe(true);
  expect(roomHandoffOf({ ...carrier })).toBeUndefined();
  for (const key of ['turnId', 'taskRunId', 'attemptId', 'childTaskId', 'deliveryId', 'callId']) {
    for (const value of ['', '\0', '\ud800', 'я'.repeat(key === 'callId' ? 257 : 65)])
      expect(() => committedRoomDelegate({ ...proof, [key]: value })).toThrow();
  }
  for (const value of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER])
    expect(() => committedRoomDelegate({ ...proof, expectedRunVersion: value })).toThrow();
});
