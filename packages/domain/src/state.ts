/**
 * TaskRun lifecycle state machine.
 *
 * State is a pure function of committed events. The transition table below is
 * the single authority for which command is legal in which state; `decide`
 * consults it instead of duplicating conditions.
 */

import type { CommandType } from './commands.js';
import type { RunBudget } from './budget.js';
import type { AttemptReason, FailureInfo, WaitingReason } from './events.js';
import type { ConversationId, PolicyId, TaskRunId, WorkspaceId } from './ids.js';

export const TASK_RUN_STATUSES = [
  'created',
  'queued',
  'admitted',
  'running',
  'waiting',
  'retrying',
  'checkpointing',
  'reconciling',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'unrecoverable',
] as const;

export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export const TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'unrecoverable',
] as const satisfies readonly TaskRunStatus[];

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminal(status: TaskRunStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Which source states admit each command.
 *
 * Cancellation is deliberately two-phase (request, then cleanup) so a forced
 * cleanup is recorded explicitly rather than inferred.
 */
export const COMMAND_SOURCES = {
  CreateTaskRun: [],
  Admit: ['created'],
  Schedule: ['queued'],
  StartAttempt: ['admitted', 'retrying'],
  // A versioned cancel can precede the active provider's final usage report.
  RecordUsage: ['running', 'cancelling'],
  Wait: ['running'],
  Resume: ['waiting'],
  Retry: ['running'],
  BeginCheckpoint: ['running'],
  CommitCheckpoint: ['checkpointing'],
  BeginReconcile: [
    'created',
    'queued',
    'admitted',
    'running',
    'waiting',
    'retrying',
    'checkpointing',
  ],
  ResolveReconcile: ['reconciling'],
  FailReconcile: ['reconciling'],
  RequestCancel: [
    'created',
    'queued',
    'admitted',
    'running',
    'waiting',
    'retrying',
    'checkpointing',
    'reconciling',
  ],
  CompleteCleanup: ['cancelling'],
  Complete: ['running'],
  Fail: ['running'],
  ExhaustBudget: ['running'],
  DenyPolicy: ['running'],
} as const satisfies Readonly<Record<CommandType, readonly TaskRunStatus[]>>;

export interface ActiveAttempt {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly reason: AttemptReason;
  readonly provider: string;
  readonly model: string;
}

export interface TerminalOutcome {
  readonly status: TerminalStatus;
  readonly failure: FailureInfo | null;
  readonly summary: string | null;
}

/** Materialized TaskRun aggregate state (a projection of its event stream). */
export interface TaskRunState {
  readonly id: TaskRunId;
  readonly status: TaskRunStatus;
  /** Last committed sequence; also the expected version for the next command. */
  readonly version: number;
  readonly conversationId: ConversationId;
  readonly workspaceId: WorkspaceId;
  readonly parentTaskRunId: TaskRunId | null;
  readonly model: string;
  readonly policyId: PolicyId;
  readonly budget: RunBudget;
  readonly activeAttempt: ActiveAttempt | null;
  readonly attemptCount: number;
  readonly waitingReason: WaitingReason | null;
  readonly pendingCheckpointId: string | null;
  readonly lastCommittedCheckpointId: string | null;
  readonly cancellationCause: string | null;
  readonly terminal: TerminalOutcome | null;
}

/**
 * Identity of a TaskRun before its creation event exists.
 * Commands against a missing aggregate use this value.
 */
export interface UncreatedTaskRun {
  readonly status: 'absent';
  readonly version: 0;
}

export type TaskRunAggregate = TaskRunState | UncreatedTaskRun;

export const ABSENT: UncreatedTaskRun = { status: 'absent', version: 0 };

export function sourceStates(command: CommandType): readonly TaskRunStatus[] {
  return COMMAND_SOURCES[command];
}
