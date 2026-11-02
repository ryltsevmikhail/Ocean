/**
 * Checkpoint and reconciliation recovery paths.
 *
 * A checkpoint commit must name the pending checkpoint and a position that is
 * already committed. Reconciliation either resumes the run or fails it into the
 * terminal `unrecoverable` state.
 */

import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  conversationId,
  decide,
  evolve,
  replay,
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
const FAILURE = { code: 'unrecoverable', message: 'external effect not found' } as const;
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
  return run(STARTED).aggregate;
}

function checkpointing(): TaskRunAggregate {
  return run([
    ...STARTED,
    cmd('BeginCheckpoint', 4, { checkpointId: 'cp_0001', attemptId: 'at_0001' }),
  ]).aggregate;
}

function reconciling(): TaskRunAggregate {
  return run([...STARTED, cmd('BeginReconcile', 4, { reason: 'reconciliation' })]).aggregate;
}

describe('checkpoints', () => {
  it('moves a running run through checkpointing and back to running', () => {
    const begin = apply(
      running(),
      cmd('BeginCheckpoint', 4, { checkpointId: 'cp_0001', attemptId: 'at_0001' }),
    );
    const checkpointingState = stateOf(begin.aggregate);
    expect(checkpointingState.status).toBe('checkpointing');
    expect(checkpointingState.pendingCheckpointId).toBe('cp_0001');
    expect(checkpointingState.version).toBe(5);
    expect(begin.events.map((event) => event.type)).toEqual(['task_run.checkpointing']);

    const commit = apply(
      begin.aggregate,
      cmd('CommitCheckpoint', 5, { checkpointId: 'cp_0001', eventPosition: 4 }),
    );
    const committed = stateOf(commit.aggregate);
    expect(committed.status).toBe('running');
    expect(committed.pendingCheckpointId).toBeNull();
    expect(committed.lastCommittedCheckpointId).toBe('cp_0001');
    expect(committed.version).toBe(6);
    expect(commit.events.map((event) => event.type)).toEqual(['checkpoint.committed']);
  });

  it('rejects a commit of an uncommitted event position', () => {
    const pending = checkpointing();
    for (const eventPosition of [0, 6, 2.5]) {
      const error = rejection(
        pending,
        cmd('CommitCheckpoint', 5, { checkpointId: 'cp_0001', eventPosition }),
      );
      expect(error.code, String(eventPosition)).toBe('invariant_violation');
      expect(error.details).toEqual({ eventPosition, committedThrough: 5 });
    }
  });

  it('rejects a commit that names a different checkpoint', () => {
    const error = rejection(
      checkpointing(),
      cmd('CommitCheckpoint', 5, { checkpointId: 'cp_0002', eventPosition: 4 }),
    );
    expect(error.code).toBe('invariant_violation');
    expect(error.details).toEqual({ pending: 'cp_0001', committed: 'cp_0002' });
  });

  it('accepts a commit of the latest committed position', () => {
    const commit = apply(
      checkpointing(),
      cmd('CommitCheckpoint', 5, { checkpointId: 'cp_0001', eventPosition: 5 }),
    );
    expect(stateOf(commit.aggregate).lastCommittedCheckpointId).toBe('cp_0001');
  });

  it('rejects an empty checkpoint id and commits outside checkpointing', () => {
    const active = running();
    const empty = rejection(
      active,
      cmd('BeginCheckpoint', 4, { checkpointId: '  ', attemptId: 'at_0001' }),
    );
    expect(empty.code).toBe('invalid_argument');

    const wrongState = rejection(
      active,
      cmd('CommitCheckpoint', 4, { checkpointId: 'cp_0001', eventPosition: 4 }),
    );
    expect(wrongState.code).toBe('invalid_transition');
    expect(wrongState.details).toEqual({ from: 'running', command: 'CommitCheckpoint' });
  });

  it('replays a checkpointed stream identically', () => {
    const { aggregate, events } = run([
      ...STARTED,
      cmd('BeginCheckpoint', 4, { checkpointId: 'cp_0001', attemptId: 'at_0001' }),
      cmd('CommitCheckpoint', 5, { checkpointId: 'cp_0001', eventPosition: 4 }),
    ]);
    expect(replay(events)).toEqual(aggregate);
    expect(stateOf(aggregate).lastCommittedCheckpointId).toBe('cp_0001');
  });
});

describe('reconciliation', () => {
  it('moves a running run through reconciling and back to running', () => {
    const begin = apply(running(), cmd('BeginReconcile', 4, { reason: 'reconciliation' }));
    const reconcilingState = stateOf(begin.aggregate);
    expect(reconcilingState.status).toBe('reconciling');
    expect(reconcilingState.waitingReason).toBe('reconciliation');

    const resolved = apply(begin.aggregate, cmd('ResolveReconcile', 5, {}));
    const resumed = stateOf(resolved.aggregate);
    expect(resumed.status).toBe('running');
    expect(resumed.waitingReason).toBeNull();
    expect(resumed.version).toBe(6);
  });

  it('rejects resolution outside reconciling', () => {
    const active = running();
    expect(rejection(active, cmd('ResolveReconcile', 4, {})).code).toBe('invalid_transition');
    expect(rejection(active, cmd('FailReconcile', 4, { failure: FAILURE })).code).toBe(
      'invalid_transition',
    );
    expect(rejection(reconciling(), cmd('Resume', 5, {})).code).toBe('invalid_transition');
  });

  it('makes a failed reconciliation unrecoverable and terminal', () => {
    const { aggregate, events } = run([
      ...STARTED,
      cmd('BeginReconcile', 4, { reason: 'reconciliation' }),
      cmd('FailReconcile', 5, { failure: FAILURE }),
    ]);
    const state = stateOf(aggregate);
    expect(state.status).toBe('unrecoverable');
    expect(state.terminal).toEqual({ status: 'unrecoverable', failure: FAILURE, summary: null });
    expect(rejection(state, cmd('ResolveReconcile', 6, {})).code).toBe('terminal_state');
    expect(replay(events)).toEqual(aggregate);
  });
});
