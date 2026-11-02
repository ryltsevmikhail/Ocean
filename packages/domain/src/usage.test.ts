/** RecordUsage commits monotonic token evidence and terminates finite budget overruns. */

import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  conversationId,
  decide,
  evolve,
  replay,
  taskRunId,
  workspaceId,
  type Actor,
  type AnyCommand,
  type Command,
  type CommandPayloads,
  type CommandType,
  type EventEnvelope,
  type TaskRunAggregate,
  type TaskRunEvent,
  type TaskRunEventDraft,
  type TaskRunState,
  type TokenUsagePayload,
} from '@runnets/domain';

const TASK_RUN = taskRunId('tr_usage01');
const ATTEMPT = 'at_0001';
const ACTOR: Actor = { kind: 'runtime', id: 'rt_0001' };

function limits(providerTokens: number | null): CommandPayloads['CreateTaskRun']['budget'] {
  return {
    active_time_ms: null,
    provider_cost_usd: null,
    provider_tokens: providerTokens,
    tool_calls: null,
    retry_attempts: null,
    child_runs: null,
    process_starts: null,
  };
}

function cmd<TType extends CommandType>(
  type: TType,
  expectedVersion: number,
  payload: CommandPayloads[TType],
): AnyCommand {
  const command: Command<TType> = {
    type,
    commandId: `cmd_${type}_${expectedVersion}`,
    taskRunId: TASK_RUN,
    expectedVersion,
    actor: ACTOR,
    payload,
  };
  return command as unknown as AnyCommand;
}

function eventOf(draft: TaskRunEventDraft, sequence: number): TaskRunEvent {
  const envelope: EventEnvelope = {
    eventId: `ev_${String(sequence).padStart(4, '0')}`,
    aggregateType: 'task_run',
    aggregateId: TASK_RUN,
    sequence,
    type: draft.type,
    schemaVersion: draft.schemaVersion,
    timestamp: '2026-01-01T00:00:00Z',
    causationId: draft.causationId,
    correlationId: 'corr_0001',
    actor: draft.actor,
    sensitivity: draft.sensitivity,
    payload: draft.payload,
  };
  return envelope as TaskRunEvent;
}

interface Fold {
  readonly aggregate: TaskRunAggregate;
  readonly events: readonly TaskRunEvent[];
}

function apply(aggregate: TaskRunAggregate, command: AnyCommand): Fold {
  const decided = decide(aggregate, command);
  if (!decided.ok) throw new Error(`unexpected ${decided.error.code} for ${command.type}`);
  let next = aggregate;
  const events: TaskRunEvent[] = [];
  for (const draft of decided.value) {
    const event = eventOf(draft, next.version + 1);
    next = evolve(next, event);
    events.push(event);
  }
  return { aggregate: next, events };
}

function stateOf(aggregate: TaskRunAggregate): TaskRunState {
  if (aggregate.status === 'absent') throw new Error('expected a created task run');
  return aggregate;
}

interface Started {
  readonly state: TaskRunState;
  readonly history: readonly TaskRunEvent[];
}

/** Drive a fresh run to `running` with one active attempt. */
function start(providerTokens: number | null = null): Started {
  let aggregate: TaskRunAggregate = ABSENT;
  const history: TaskRunEvent[] = [];
  const steps: Array<[CommandType, CommandPayloads[CommandType]]> = [
    [
      'CreateTaskRun',
      {
        conversationId: conversationId('cv_0001'),
        workspaceId: workspaceId('ws_0001'),
        parentTaskRunId: null,
        model: 'test-model',
        policyId: 'pl_0001',
        budget: limits(providerTokens),
      },
    ],
    ['Admit', {}],
    ['Schedule', {}],
    ['StartAttempt', { attemptId: ATTEMPT, reason: 'initial', provider: 'test', model: 'test' }],
  ];
  for (const [type, payload] of steps) {
    const fold = apply(aggregate, cmd(type, aggregate.version, payload));
    aggregate = fold.aggregate;
    history.push(...fold.events);
  }
  return { state: stateOf(aggregate), history };
}

function running(providerTokens: number | null = null): TaskRunState {
  return start(providerTokens).state;
}

function record(state: TaskRunState, usage: TokenUsagePayload): Fold {
  return apply(state, cmd('RecordUsage', state.version, { attemptId: ATTEMPT, usage }));
}

function errorCode(state: TaskRunAggregate, command: AnyCommand): string {
  const decided = decide(state, command);
  if (decided.ok) throw new Error(`expected ${command.type} to be rejected`);
  return decided.error.code;
}

describe('RecordUsage', () => {
  it('commits attempt usage and consumes provider tokens', () => {
    const before = running();
    const fold = record(before, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });

    expect(fold.events.map((event) => event.type)).toEqual(['attempt.usage_recorded']);
    const after = stateOf(fold.aggregate);
    expect(after.status).toBe('running');
    expect(after.budget.consumed.provider_tokens).toBe(10);
    expect(fold.events[0]?.payload).toEqual({
      attemptId: ATTEMPT,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
  });

  it('accumulates usage monotonically across settlements', () => {
    const first = record(running(), { inputTokens: 4, outputTokens: 6, totalTokens: 10 });
    const second = record(stateOf(first.aggregate), {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    expect(stateOf(second.aggregate).budget.consumed.provider_tokens).toBe(25);
    expect(second.events.map((event) => event.type)).toEqual(['attempt.usage_recorded']);
  });

  it('does not terminate when usage reaches the limit exactly', () => {
    const fold = record(running(100), { inputTokens: 60, outputTokens: 40, totalTokens: 100 });

    expect(fold.events.map((event) => event.type)).toEqual(['attempt.usage_recorded']);
    expect(stateOf(fold.aggregate).status).toBe('running');
    expect(stateOf(fold.aggregate).budget.consumed.provider_tokens).toBe(100);
  });

  it('commits budget exhaustion when usage crosses a finite limit', () => {
    const fold = record(running(100), { inputTokens: 70, outputTokens: 50, totalTokens: 120 });

    expect(fold.events.map((event) => event.type)).toEqual([
      'attempt.usage_recorded',
      'task_run.budget_exhausted',
    ]);
    expect(fold.events[1]?.payload).toEqual({
      dimension: 'provider_tokens',
      limit: 100,
      consumed: 120,
    });
    const after = stateOf(fold.aggregate);
    expect(after.status).toBe('budget_exhausted');
    expect(after.budget.consumed.provider_tokens).toBe(120);
    expect(after.terminal).toEqual({
      status: 'budget_exhausted',
      failure: null,
      summary: 'provider_tokens:120/100',
    });
    expect(after.activeAttempt?.attemptId).toBe(ATTEMPT);
  });

  it('rejects usage for a non-active attempt', () => {
    const state = running();
    const code = errorCode(
      state,
      cmd('RecordUsage', state.version, {
        attemptId: 'at_other',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    );
    expect(code).toBe('invariant_violation');
  });

  it('rejects usage before an attempt is running', () => {
    const created = apply(
      ABSENT,
      cmd('CreateTaskRun', 0, {
        conversationId: conversationId('cv_0001'),
        workspaceId: workspaceId('ws_0001'),
        parentTaskRunId: null,
        model: 'test-model',
        policyId: 'pl_0001',
        budget: limits(null),
      }),
    ).aggregate;

    const code = errorCode(
      created,
      cmd('RecordUsage', created.version, {
        attemptId: ATTEMPT,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    );
    expect(code).toBe('invalid_transition');
  });

  it('rejects negative or fractional token counts', () => {
    const state = running();
    for (const usage of [
      { inputTokens: -1, outputTokens: 1, totalTokens: 0 },
      { inputTokens: 1.5, outputTokens: 1, totalTokens: 2.5 },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0.5 },
    ]) {
      expect(
        errorCode(state, cmd('RecordUsage', state.version, { attemptId: ATTEMPT, usage })),
      ).toBe('invalid_argument');
    }
  });

  it('rejects usage after the run became terminal', () => {
    const exhausted = stateOf(
      record(running(100), { inputTokens: 70, outputTokens: 50, totalTokens: 120 }).aggregate,
    );
    const code = errorCode(
      exhausted,
      cmd('RecordUsage', exhausted.version, {
        attemptId: ATTEMPT,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    );
    expect(code).toBe('terminal_state');
  });

  it('rebuilds usage and exhaustion from the committed stream alone', () => {
    const started = start(100);
    const fold = record(started.state, { inputTokens: 70, outputTokens: 50, totalTokens: 120 });
    const replayed = stateOf(replay([...started.history, ...fold.events]));

    expect(replayed.status).toBe('budget_exhausted');
    expect(replayed.budget.consumed.provider_tokens).toBe(120);
    expect(replayed.version).toBe(started.history.length + fold.events.length);
  });
});

describe('attempt.usage_recorded evolution', () => {
  it('throws when a committed event carries invalid token counts', () => {
    const state = running();
    const event = eventOf(
      {
        type: 'attempt.usage_recorded',
        payload: {
          attemptId: ATTEMPT,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: -1 },
        },
        actor: ACTOR,
        causationId: 'cmd_invalid',
        sensitivity: 'internal',
        schemaVersion: 1,
      },
      state.version + 1,
    );

    expect(() => evolve(state, event)).toThrow(/invalid token counts/);
  });
});
