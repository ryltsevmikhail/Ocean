/**
 * TaskRun lifecycle tests.
 *
 * Commands are decided against the current aggregate and then folded into
 * synthetic event envelopes, so every assertion runs through the same
 * `decide` + `evolve` path a durable log would use.
 */

import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  conversationId,
  decide,
  evolve,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type Actor,
  type AnyCommand,
  type AttemptReason,
  type Command,
  type CommandPayloads,
  type CommandType,
  type EventEnvelope,
  type TaskRunAggregate,
  type TaskRunEvent,
  type TaskRunEventDraft,
  type TaskRunState,
  type TaskRunStatus,
} from '@runnets/domain';

const TASK_RUN = taskRunId('tr_0001');
const ACTOR: Actor = { kind: 'runtime', id: 'rt_0001' };
const MODEL = 'test-model';
const CREATE_PAYLOAD: CommandPayloads['CreateTaskRun'] = {
  conversationId: conversationId('cv_0001'),
  workspaceId: workspaceId('ws_0001'),
  parentTaskRunId: null,
  model: MODEL,
  policyId: 'pl_0001',
  budget: unlimitedBudget(),
};

/** Build a command envelope; the caller declares the version it expects. */
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

/** Turn a decided draft into the envelope a committed log would have assigned. */
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

/** Decide one command and evolve the drafts into committed events. */
function apply(aggregate: TaskRunAggregate, command: AnyCommand): Fold {
  const decided = decide(aggregate, command);
  if (!decided.ok) {
    throw new Error(`unexpected ${decided.error.code} for ${command.type}`);
  }
  let next = aggregate;
  const events: TaskRunEvent[] = [];
  for (const draft of decided.value) {
    const event = eventOf(draft, next.version + 1);
    next = evolve(next, event);
    events.push(event);
  }
  return { aggregate: next, events };
}

/** Apply a command sequence starting from an absent aggregate. */
function run(commands: readonly AnyCommand[]): Fold {
  let aggregate: TaskRunAggregate = ABSENT;
  const events: TaskRunEvent[] = [];
  for (const command of commands) {
    const step = apply(aggregate, command);
    aggregate = step.aggregate;
    events.push(...step.events);
  }
  return { aggregate, events };
}

/** Narrow a created aggregate, failing loudly while it is still absent. */
function stateOf(aggregate: TaskRunAggregate): TaskRunState {
  if (aggregate.status === 'absent') throw new Error('expected a created TaskRun aggregate');
  return aggregate;
}

function startAttempt(version: number, attemptId: string, reason: AttemptReason = 'initial') {
  return cmd('StartAttempt', version, { attemptId, reason, provider: 'provider-a', model: MODEL });
}

function startedCommands(): AnyCommand[] {
  return [
    cmd('CreateTaskRun', 0, CREATE_PAYLOAD),
    cmd('Admit', 1, {}),
    cmd('Schedule', 2, {}),
    startAttempt(3, 'at_0001'),
  ];
}

function runningAggregate(): TaskRunAggregate {
  return run(startedCommands()).aggregate;
}

describe('TaskRun lifecycle', () => {
  it('folds creation, queueing, admission, attempt start, and success', () => {
    const commands = [
      ...startedCommands(),
      cmd('Complete', 4, { summary: 'all checks pass', attemptId: 'at_0001' }),
    ];
    const { aggregate, events } = run(commands);

    expect(events.map((event) => event.type)).toEqual([
      'task_run.created',
      'task_run.queued',
      'task_run.admitted',
      'attempt.started',
      'task_run.succeeded',
    ]);
    const state = stateOf(aggregate);
    expect(state.status).toBe('succeeded');
    expect(state.version).toBe(5);
    expect(state.model).toBe(MODEL);
    expect(state.policyId).toBe('pl_0001');
    expect(state.attemptCount).toBe(1);
    expect(state.activeAttempt).toEqual({
      attemptId: 'at_0001',
      ordinal: 1,
      reason: 'initial',
      provider: 'provider-a',
      model: MODEL,
    });
    expect(state.terminal).toEqual({
      status: 'succeeded',
      failure: null,
      summary: 'all checks pass',
    });
  });

  it('exposes each intermediate status while folding the stream', () => {
    const statuses: TaskRunStatus[] = [];
    let aggregate: TaskRunAggregate = ABSENT;
    const commands = [
      ...startedCommands(),
      cmd('Complete', 4, { summary: 'done', attemptId: 'at_0001' }),
    ];
    for (const command of commands) {
      aggregate = apply(aggregate, command).aggregate;
      statuses.push(stateOf(aggregate).status);
    }
    expect(statuses).toEqual(['created', 'queued', 'admitted', 'running', 'succeeded']);
  });

  it('parks a running run in waiting and resumes it', () => {
    const waiting = apply(runningAggregate(), cmd('Wait', 4, { reason: 'approval' }));
    const waitingState = stateOf(waiting.aggregate);
    expect(waitingState.status).toBe('waiting');
    expect(waitingState.waitingReason).toBe('approval');
    expect(waitingState.version).toBe(5);

    const resumed = apply(waiting.aggregate, cmd('Resume', 5, {}));
    const resumedState = stateOf(resumed.aggregate);
    expect(resumedState.status).toBe('running');
    expect(resumedState.waitingReason).toBeNull();
    expect(resumedState.version).toBe(6);
  });

  it('schedules a retry and increments the attempt ordinal across retries', () => {
    let aggregate = runningAggregate();
    expect(stateOf(aggregate).activeAttempt?.ordinal).toBe(1);

    const retry = apply(
      aggregate,
      cmd('Retry', 4, { attemptId: 'at_0001', delayMs: 1000, dueAt: '2026-01-01T00:00:05Z' }),
    );
    expect(retry.events.map((event) => event.type)).toEqual(['attempt.retry_scheduled']);
    expect(stateOf(retry.aggregate).status).toBe('retrying');

    aggregate = apply(retry.aggregate, startAttempt(5, 'at_0002', 'retry')).aggregate;
    expect(stateOf(aggregate).status).toBe('running');
    expect(stateOf(aggregate).activeAttempt?.ordinal).toBe(2);
    expect(stateOf(aggregate).attemptCount).toBe(2);

    aggregate = apply(
      aggregate,
      cmd('Retry', 6, { attemptId: 'at_0002', delayMs: 500, dueAt: '2026-01-01T00:00:10Z' }),
    ).aggregate;
    aggregate = apply(aggregate, startAttempt(7, 'at_0003', 'retry')).aggregate;
    expect(stateOf(aggregate).activeAttempt?.ordinal).toBe(3);
    expect(stateOf(aggregate).attemptCount).toBe(3);
  });

  const PRELUDE = startedCommands();
  const CANCEL_PREFIXES: ReadonlyArray<readonly [TaskRunStatus, readonly AnyCommand[]]> = [
    ['created', PRELUDE.slice(0, 1)],
    ['queued', PRELUDE.slice(0, 2)],
    ['admitted', PRELUDE.slice(0, 3)],
    ['running', PRELUDE],
    ['waiting', [...PRELUDE, cmd('Wait', 4, { reason: 'approval' })]],
    [
      'retrying',
      [
        ...PRELUDE,
        cmd('Retry', 4, { attemptId: 'at_0001', delayMs: 1, dueAt: '2026-01-01T00:00:05Z' }),
      ],
    ],
    [
      'checkpointing',
      [...PRELUDE, cmd('BeginCheckpoint', 4, { checkpointId: 'cp_0001', attemptId: 'at_0001' })],
    ],
    ['reconciling', [...PRELUDE, cmd('BeginReconcile', 4, { reason: 'reconciliation' })]],
  ];

  for (const [expectedStatus, prefix] of CANCEL_PREFIXES) {
    it(`cancels a ${expectedStatus} run in two phases`, () => {
      const before = run(prefix);
      expect(stateOf(before.aggregate).status).toBe(expectedStatus);

      const cancelling = apply(
        before.aggregate,
        cmd('RequestCancel', before.aggregate.version, { cause: 'user_request' }),
      );
      const cancellingState = stateOf(cancelling.aggregate);
      expect(cancellingState.status).toBe('cancelling');
      expect(cancellingState.cancellationCause).toBe('user_request');

      const cancelled = apply(
        cancelling.aggregate,
        cmd('CompleteCleanup', cancelling.aggregate.version, { cleanup: 'completed' }),
      );
      const cancelledState = stateOf(cancelled.aggregate);
      expect(cancelledState.status).toBe('cancelled');
      expect(cancelledState.terminal).toEqual({
        status: 'cancelled',
        failure: null,
        summary: 'completed',
      });
    });
  }

  it('records a forced cleanup explicitly', () => {
    const cancelling = apply(
      run([cmd('CreateTaskRun', 0, CREATE_PAYLOAD)]).aggregate,
      cmd('RequestCancel', 1, { cause: 'shutdown' }),
    );
    const cancelled = apply(cancelling.aggregate, cmd('CompleteCleanup', 2, { cleanup: 'forced' }));
    expect(stateOf(cancelled.aggregate).terminal).toEqual({
      status: 'cancelled',
      failure: null,
      summary: 'forced',
    });
  });

  it('rejects a second cancellation request while cleanup is pending', () => {
    const cancelling = apply(
      run([cmd('CreateTaskRun', 0, CREATE_PAYLOAD)]).aggregate,
      cmd('RequestCancel', 1, { cause: 'user_request' }),
    ).aggregate;
    const result = decide(cancelling, cmd('RequestCancel', 2, { cause: 'again' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the second request to be rejected');
    expect(result.error.code).toBe('invalid_transition');
    expect(result.error.details).toEqual({ from: 'cancelling', command: 'RequestCancel' });
  });
});
