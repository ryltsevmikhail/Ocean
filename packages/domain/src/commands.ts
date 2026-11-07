/**
 * TaskRun commands.
 *
 * Every command is an intent that must name the version it expects. The
 * application layer rejects a stale command instead of guessing, which keeps
 * state transitions derived from committed events only.
 */

import type { StartModelRequestPayload, SettleModelRequestPayload } from './model-dispatch.js';
import type {
  Actor,
  AttemptReason,
  BudgetLimitsPayload,
  FailureInfo,
  TokenUsagePayload,
  WaitingReason,
} from './events.js';
import type { ConversationId, TaskRunId, WorkspaceId } from './ids.js';

export interface CommandPayloads {
  CreateTaskRun: {
    readonly conversationId: ConversationId;
    readonly workspaceId: WorkspaceId;
    readonly parentTaskRunId: TaskRunId | null;
    readonly model: string;
    readonly policyId: string;
    readonly budget: BudgetLimitsPayload;
  };
  Admit: Record<string, never>;
  Schedule: Record<string, never>;
  StartAttempt: {
    readonly attemptId: string;
    readonly reason: AttemptReason;
    readonly provider: string;
    readonly model: string;
  };
  StartModelRequest: StartModelRequestPayload;
  SettleModelRequest: SettleModelRequestPayload;
  RecordUsage: {
    readonly attemptId: string;
    readonly usage: TokenUsagePayload;
  };
  Wait: { readonly reason: WaitingReason };
  Resume: Record<string, never>;
  Retry: { readonly delayMs: number; readonly dueAt: string; readonly attemptId: string };
  BeginCheckpoint: { readonly checkpointId: string; readonly attemptId: string | null };
  CommitCheckpoint: { readonly checkpointId: string; readonly eventPosition: number };
  BeginReconcile: { readonly reason: WaitingReason };
  ResolveReconcile: Record<string, never>;
  FailReconcile: { readonly failure: FailureInfo };
  RequestCancel: { readonly cause: string };
  CompleteCleanup: { readonly cleanup: 'completed' | 'forced' };
  Complete: { readonly summary: string; readonly attemptId: string };
  Fail: { readonly failure: FailureInfo; readonly attemptId: string | null };
  ExhaustBudget: {
    readonly dimension: string;
    readonly limit: number;
    readonly consumed: number;
  };
  DenyPolicy: { readonly capability: string; readonly reason: string };
}

export type CommandType = keyof CommandPayloads;

/**
 * A command envelope. `commandId` is the idempotency key: replaying the same
 * command id must not produce a second effect.
 */
export interface Command<TType extends CommandType = CommandType> {
  readonly type: TType;
  readonly commandId: string;
  readonly taskRunId: TaskRunId;
  readonly expectedVersion: number;
  readonly actor: Actor;
  readonly payload: CommandPayloads[TType];
}

export type AnyCommand = {
  [TType in CommandType]: Command<TType>;
}[CommandType];

/** Identity of the TaskRun a command targets, independent of the variant. */
export function commandTarget(command: AnyCommand): TaskRunId {
  return command.taskRunId;
}
