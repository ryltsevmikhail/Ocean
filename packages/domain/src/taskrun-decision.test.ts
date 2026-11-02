/**
 * Decision fencing.
 *
 * `decide` never mutates state and never throws for expected outcomes: stale
 * versions, illegal transitions, and invalid payloads all come back as typed
 * `DomainError` codes.
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
  type Command,
  type CommandPayloads,
  type CommandType,
  type DomainError,
  type EventEnvelope,
  type TaskRunAggregate,
  type TaskRunEvent,
  type TaskRunEventDraft,
  type TaskRunState,
} from '@runnets/domain';

const TASK_RUN = taskRunId('tr_0001');
const ACTOR: Actor = { kind: 'runtime', id: 'rt_0001' };
const MODEL = 'test-model';
const FAILURE = { code: 'provider_error', message: 'provider crashed' } as const;
const CREATE_PAYLOAD: CommandPayloads['CreateTaskRun'] = {
  conversationId: conversationId('cv_0001'),
  workspaceId: workspaceId('ws_0001'),
  parentTaskRunId: null,
  model: MODEL,
  policyId: 'pl_0001',
  budget: unlimitedBudget(),
};

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

/** Decide each command against the aggregate so far and evolve its events. */
function run(commands: readonly AnyCommand[]): TaskRunAggregate {
  let aggregate: TaskRunAggregate = ABSENT;
  for (const command of commands) {
    const decided = decide(aggregate, command);
    if (!decided.ok) throw new Error(`unexpected ${decided.error.code} for ${command.type}`);
    for (const draft of decided.value) {
      aggregate = evolve(aggregate, eventOf(draft, aggregate.version + 1));
    }
  }
  return aggregate;
}

function stateOf(aggregate: TaskRunAggregate): TaskRunState {
  if (aggregate.status === 'absent') throw new Error('expected a created TaskRun aggregate');
  return aggregate;
}

function rejection(aggregate: TaskRunAggregate, command: AnyCommand): DomainError {
  const decided = decide(aggregate, command);
  if (decided.ok) throw new Error(`expected ${command.type} to be rejected`);
  return decided.error;
}

const STARTED: AnyCommand[] = [
  cmd('CreateTaskRun', 0, CREATE_PAYLOAD),
  cmd('Admit', 1, {}),
  cmd('Schedule', 2, {}),
  cmd('StartAttempt', 3, {
    attemptId: 'at_0001',
    reason: 'initial',
    provider: 'provider-a',
    model: MODEL,
  }),
];

function running(): TaskRunAggregate {
  return run(STARTED);
}

describe('expected version fencing', () => {
  it('rejects a command whose expectedVersion is stale', () => {
    const error = rejection(running(), cmd('Wait', 3, { reason: 'approval' }));
    expect(error.code).toBe('version_conflict');
    expect(error.details).toEqual({ expected: 3, actual: 4 });
  });

  it('fences creation behind version zero', () => {
    const error = rejection(ABSENT, cmd('CreateTaskRun', 1, CREATE_PAYLOAD));
    expect(error.code).toBe('version_conflict');
    expect(error.details).toEqual({ expected: 1, actual: 0 });
  });

  it('checks the expected version before the transition table', () => {
    const created = run([cmd('CreateTaskRun', 0, CREATE_PAYLOAD)]);
    const error = rejection(created, cmd('Wait', 0, { reason: 'approval' }));
    expect(error.code).toBe('version_conflict');
  });

  it('rejects a command that is illegal in the current state', () => {
    const created = run([cmd('CreateTaskRun', 0, CREATE_PAYLOAD)]);
    const error = rejection(created, cmd('Complete', 1, { summary: 'done', attemptId: 'at_0001' }));
    expect(error.code).toBe('invalid_transition');
    expect(error.details).toEqual({ from: 'created', command: 'Complete' });
  });

  it('rejects invalid command payloads with invalid_argument', () => {
    const emptyModel = rejection(
      ABSENT,
      cmd('CreateTaskRun', 0, { ...CREATE_PAYLOAD, model: '   ' }),
    );
    expect(emptyModel.code).toBe('invalid_argument');

    const admitted = run([
      cmd('CreateTaskRun', 0, CREATE_PAYLOAD),
      cmd('Admit', 1, {}),
      cmd('Schedule', 2, {}),
    ]);
    const blankAttempt = rejection(
      admitted,
      cmd('StartAttempt', 3, { attemptId: ' ', reason: 'initial', provider: 'p', model: MODEL }),
    );
    expect(blankAttempt.code).toBe('invalid_argument');

    const active = running();
    const negativeDelay = rejection(
      active,
      cmd('Retry', 4, { attemptId: 'at_0001', delayMs: -1, dueAt: '2026-01-01T00:00:05Z' }),
    );
    expect(negativeDelay.code).toBe('invalid_argument');
    const localTime = rejection(
      active,
      cmd('Retry', 4, { attemptId: 'at_0001', delayMs: 1000, dueAt: '2026-01-01 00:00:05' }),
    );
    expect(localTime.code).toBe('invalid_argument');
  });

  it('rejects a completion that references a non-active attempt', () => {
    const error = rejection(
      running(),
      cmd('Complete', 4, { summary: 'done', attemptId: 'at_9999' }),
    );
    expect(error.code).toBe('invariant_violation');
    expect(error.details).toEqual({ active: 'at_0001', referenced: 'at_9999' });
  });

  it('records a run-level failure without an attempt reference', () => {
    const aggregate = run([...STARTED, cmd('Fail', 4, { failure: FAILURE, attemptId: null })]);
    expect(stateOf(aggregate).terminal).toEqual({
      status: 'failed',
      failure: FAILURE,
      summary: null,
    });
  });
});
