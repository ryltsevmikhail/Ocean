/**
 * Event-sourcing identity.
 *
 * Folding a stream of committed events must reproduce exactly the aggregate the
 * incremental decisions produced, at every prefix of the stream. Event
 * envelopes are synthetic but carry the same metadata a real log would assign.
 */

import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  conversationId,
  decide,
  draft,
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
  type EventEnvelope,
  type TaskRunAggregate,
  type TaskRunEvent,
  type TaskRunEventDraft,
  type TaskRunEventType,
  type TaskRunState,
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

function firstEventOfType<TType extends TaskRunEventType>(
  events: readonly TaskRunEvent[],
  type: TType,
): TaskRunEvent {
  const found = events.find((event) => event.type === type);
  if (found === undefined) throw new Error(`no ${type} event in the stream`);
  return found;
}

const STREAM: AnyCommand[] = [
  cmd('CreateTaskRun', 0, CREATE_PAYLOAD),
  cmd('Admit', 1, {}),
  cmd('Schedule', 2, {}),
  cmd('StartAttempt', 3, {
    attemptId: 'at_0001',
    reason: 'initial',
    provider: 'provider-a',
    model: MODEL,
  }),
  cmd('Wait', 4, { reason: 'approval' }),
  cmd('Resume', 5, {}),
  cmd('Retry', 6, { attemptId: 'at_0001', delayMs: 1000, dueAt: '2026-01-01T00:00:05Z' }),
  cmd('StartAttempt', 7, {
    attemptId: 'at_0002',
    reason: 'retry',
    provider: 'provider-a',
    model: MODEL,
  }),
  cmd('BeginCheckpoint', 8, { checkpointId: 'cp_0001', attemptId: 'at_0002' }),
  cmd('CommitCheckpoint', 9, { checkpointId: 'cp_0001', eventPosition: 8 }),
  cmd('Complete', 10, { summary: 'done', attemptId: 'at_0002' }),
];

describe('synthetic event envelopes', () => {
  it('attributes decided events to the command actor and command id', () => {
    const { events } = apply(
      run(STREAM.slice(0, 4)).aggregate,
      cmd('Wait', 4, { reason: 'approval' }),
    );
    expect(events.map((event) => event.causationId)).toEqual(['cmd_Wait_4']);
    expect(events.map((event) => event.actor)).toEqual([ACTOR]);
    expect(events.map((event) => event.sensitivity)).toEqual(['internal']);
    expect(events.map((event) => event.schemaVersion)).toEqual([1]);
  });

  it('lets callers override draft metadata', () => {
    const event = draft(
      'task_run.queued',
      {},
      { actor: ACTOR, causationId: 'cmd_0001', sensitivity: 'restricted' },
    );
    expect(event).toEqual({
      type: 'task_run.queued',
      payload: {},
      actor: ACTOR,
      causationId: 'cmd_0001',
      sensitivity: 'restricted',
      schemaVersion: 1,
    });
  });
});

describe('event-sourcing identity', () => {
  it('numbers the committed stream contiguously from one', () => {
    const { events } = run(STREAM);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_unused, index) => index + 1),
    );
    expect(events.map((event) => event.eventId)).toEqual(
      Array.from(
        { length: events.length },
        (_unused, index) => `ev_${String(index + 1).padStart(4, '0')}`,
      ),
    );
    expect(events.every((event) => event.aggregateId === TASK_RUN)).toBe(true);
    expect(events.every((event) => event.aggregateType === 'task_run')).toBe(true);
    expect(events.every((event) => event.timestamp === '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('replays the committed stream into the folded aggregate', () => {
    const { aggregate, events } = run(STREAM);
    const state = stateOf(aggregate);
    expect(state.status).toBe('succeeded');
    expect(state.version).toBe(11);
    expect(state.attemptCount).toBe(2);
    expect(state.lastCommittedCheckpointId).toBe('cp_0001');
    expect(state.terminal).toEqual({ status: 'succeeded', failure: null, summary: 'done' });
    expect(replay(events)).toEqual(aggregate);
  });

  it('matches the folded aggregate at every prefix of the stream', () => {
    for (let length = 0; length <= STREAM.length; length += 1) {
      const folded = run(STREAM.slice(0, length));
      expect(replay(folded.events)).toEqual(folded.aggregate);
    }
  });

  it('replays an empty stream to the absent aggregate', () => {
    expect(replay([])).toBe(ABSENT);
  });
});

describe('malformed streams', () => {
  it('refuses an event applied before the creation event', () => {
    const events = run(STREAM.slice(0, 2)).events;
    const queued = firstEventOfType(events, 'task_run.queued');
    expect(() => evolve(ABSENT, queued)).toThrow(/no creation event/);
  });

  it('refuses a second creation event', () => {
    const { aggregate, events } = run(STREAM.slice(0, 1));
    const created = firstEventOfType(events, 'task_run.created');
    expect(() => evolve(aggregate, created)).toThrow(/already exists/);
  });
});
