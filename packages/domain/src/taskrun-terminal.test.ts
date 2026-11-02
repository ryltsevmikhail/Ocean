/**
 * Terminal TaskRun immutability.
 *
 * Once a run reaches an outcome state every later command is rejected with
 * `terminal_state`, regardless of the version it expects. Terminality is
 * checked before expected-version fencing.
 */

import { describe, expect, it } from 'vitest';
import {
  ABSENT,
  COMMAND_SOURCES,
  conversationId,
  decide,
  evolve,
  isTerminal,
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
  type TaskRunStatus,
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

/** One valid payload per command, used to probe every command in a state. */
const SAMPLES: { readonly [TType in CommandType]: CommandPayloads[TType] } = {
  CreateTaskRun: CREATE_PAYLOAD,
  Admit: {},
  Schedule: {},
  StartAttempt: { attemptId: 'at_0001', reason: 'initial', provider: 'provider-a', model: MODEL },
  RecordUsage: {
    attemptId: 'at_0001',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  },
  Wait: { reason: 'approval' },
  Resume: {},
  Retry: { attemptId: 'at_0001', delayMs: 1000, dueAt: '2026-01-01T00:00:05Z' },
  BeginCheckpoint: { checkpointId: 'cp_0001', attemptId: 'at_0001' },
  CommitCheckpoint: { checkpointId: 'cp_0001', eventPosition: 1 },
  BeginReconcile: { reason: 'reconciliation' },
  ResolveReconcile: {},
  FailReconcile: { failure: FAILURE },
  RequestCancel: { cause: 'user_request' },
  CompleteCleanup: { cleanup: 'completed' },
  Complete: { summary: 'done', attemptId: 'at_0001' },
  Fail: { failure: FAILURE, attemptId: 'at_0001' },
  ExhaustBudget: { dimension: 'tool_calls', limit: 10, consumed: 10 },
  DenyPolicy: { capability: 'shell', reason: 'denied' },
};

const COMMAND_TYPES = Object.keys(COMMAND_SOURCES) as CommandType[];

function succeeded(): TaskRunAggregate {
  return run([...STARTED, cmd('Complete', 4, { summary: 'done', attemptId: 'at_0001' })]);
}

function failed(): TaskRunAggregate {
  return run([...STARTED, cmd('Fail', 4, { failure: FAILURE, attemptId: 'at_0001' })]);
}

function cancelled(): TaskRunAggregate {
  return run([
    cmd('CreateTaskRun', 0, CREATE_PAYLOAD),
    cmd('RequestCancel', 1, { cause: 'user_request' }),
    cmd('CompleteCleanup', 2, { cleanup: 'completed' }),
  ]);
}

function budgetExhausted(): TaskRunAggregate {
  return run([
    ...STARTED,
    cmd('ExhaustBudget', 4, { dimension: 'tool_calls', limit: 10, consumed: 10 }),
  ]);
}

function policyDenied(): TaskRunAggregate {
  return run([...STARTED, cmd('DenyPolicy', 4, { capability: 'shell', reason: 'denied' })]);
}

function unrecoverable(): TaskRunAggregate {
  return run([
    ...STARTED,
    cmd('BeginReconcile', 4, { reason: 'reconciliation' }),
    cmd('FailReconcile', 5, { failure: FAILURE }),
  ]);
}

const TERMINAL_FIXTURES: ReadonlyArray<readonly [TaskRunStatus, () => TaskRunAggregate]> = [
  ['succeeded', succeeded],
  ['failed', failed],
  ['cancelled', cancelled],
  ['budget_exhausted', budgetExhausted],
  ['policy_denied', policyDenied],
  ['unrecoverable', unrecoverable],
];

describe('terminal TaskRun immutability', () => {
  it('covers every command type in the source table', () => {
    expect(COMMAND_TYPES).toHaveLength(19);
  });

  for (const [expectedStatus, fixture] of TERMINAL_FIXTURES) {
    it(`rejects every command once the run is ${expectedStatus}`, () => {
      const terminal = stateOf(fixture());
      expect(terminal.status).toBe(expectedStatus);
      for (const type of COMMAND_TYPES) {
        const error = rejection(terminal, cmd(type, terminal.version, SAMPLES[type]));
        expect(error.code, type).toBe('terminal_state');
        expect(error.details).toEqual({ state: expectedStatus, command: type });
      }
    });
  }

  it('rejects creation once the run is terminal', () => {
    const terminal = stateOf(succeeded());
    const error = rejection(terminal, cmd('CreateTaskRun', 0, CREATE_PAYLOAD));
    expect(error.code).toBe('terminal_state');
  });

  it('checks terminality before version fencing', () => {
    const terminal = stateOf(succeeded());
    const error = rejection(terminal, cmd('Wait', terminal.version + 100, { reason: 'approval' }));
    expect(error.code).toBe('terminal_state');
    expect(error.details).toEqual({ state: 'succeeded', command: 'Wait' });
  });

  it('classifies only outcome statuses as terminal', () => {
    const inFlight: readonly TaskRunStatus[] = [
      'created',
      'queued',
      'admitted',
      'running',
      'waiting',
      'retrying',
      'checkpointing',
      'reconciling',
      'cancelling',
    ];
    for (const status of inFlight) expect(isTerminal(status), status).toBe(false);
    for (const [, fixture] of TERMINAL_FIXTURES) {
      expect(isTerminal(stateOf(fixture()).status)).toBe(true);
    }
  });
});

describe('command source table', () => {
  it('declares the states that admit each command', () => {
    expect(COMMAND_SOURCES.CreateTaskRun).toEqual([]);
    expect(COMMAND_SOURCES.Admit).toEqual(['created']);
    expect(COMMAND_SOURCES.Schedule).toEqual(['queued']);
    expect(COMMAND_SOURCES.StartAttempt).toEqual(['admitted', 'retrying']);
    expect(COMMAND_SOURCES.RecordUsage).toEqual(['running']);
    expect(COMMAND_SOURCES.CompleteCleanup).toEqual(['cancelling']);
    expect(COMMAND_SOURCES.RequestCancel).toEqual([
      'created',
      'queued',
      'admitted',
      'running',
      'waiting',
      'retrying',
      'checkpointing',
      'reconciling',
    ]);
  });
});
