/**
 * Durable event contract.
 *
 * The Event Log is the source of truth: TaskRun state is derived only from
 * committed, ordered events. This module owns the envelope and the typed event
 * vocabulary; it contains no storage or transport concerns.
 */

import type { StartModelRequestPayload, SettleModelRequestPayload } from './model-dispatch.js';
import type { ConversationId, PolicyId, TaskRunId, WorkspaceId } from './ids.js';

export const AGGREGATE_TYPES = [
  'task_run',
  'conversation',
  'workspace',
  'capability_policy',
  'process_tree',
] as const;

export type AggregateType = (typeof AGGREGATE_TYPES)[number];

export type ActorKind = 'user' | 'runtime' | 'scheduler' | 'tool' | 'provider' | 'policy';

export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
}

/** Classification of event payload sensitivity for audit and redaction. */
export type Sensitivity = 'public' | 'internal' | 'restricted';

/**
 * Immutable, ordered record committed to an aggregate stream.
 * `sequence` is 1-based and strictly contiguous per aggregate.
 */
export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  readonly eventId: string;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly type: TType;
  readonly schemaVersion: number;
  readonly timestamp: string;
  readonly causationId: string | null;
  readonly correlationId: string;
  readonly actor: Actor;
  readonly sensitivity: Sensitivity;
  readonly payload: TPayload;
}

/**
 * Event produced by a domain decision, before the log assigns identity,
 * ordering, and commit timestamp.
 */
export interface EventDraft<TType extends string = string, TPayload = unknown> {
  readonly type: TType;
  readonly payload: TPayload;
  readonly actor: Actor;
  readonly sensitivity: Sensitivity;
  readonly schemaVersion: number;
  readonly causationId: string | null;
}

export const TASK_RUN_SCHEMA_VERSION = 1;

export type AttemptReason = 'initial' | 'retry' | 'resume' | 'reconcile';

export type WaitingReason =
  | 'approval'
  | 'retry_delay'
  | 'child_result'
  | 'tool_process'
  | 'external_input'
  | 'resource_capacity'
  | 'reconciliation';

export type FailureCode =
  | 'provider_error'
  | 'tool_error'
  | 'context_overflow'
  | 'policy_denied'
  | 'internal_error'
  | 'unrecoverable';

export interface FailureInfo {
  readonly code: FailureCode;
  readonly message: string;
}

export interface BudgetLimitsPayload {
  readonly active_time_ms: number | null;
  readonly provider_cost_usd: number | null;
  readonly provider_tokens: number | null;
  readonly tool_calls: number | null;
  readonly retry_attempts: number | null;
  readonly child_runs: number | null;
  readonly process_starts: number | null;
}

export interface TaskRunCreatedPayload {
  readonly conversationId: ConversationId;
  readonly workspaceId: WorkspaceId;
  readonly parentTaskRunId: TaskRunId | null;
  readonly model: string;
  readonly policyId: PolicyId;
  readonly budget: BudgetLimitsPayload;
}

export interface AttemptStartedPayload {
  readonly attemptId: string;
  readonly ordinal: number;
  readonly reason: AttemptReason;
  readonly provider: string;
  readonly model: string;
}

/** Token usage reported by a provider for one attempt. */
export interface TokenUsagePayload {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * Committed usage settlement for one attempt.
 *
 * Each committed report is attempt-scoped usage evidence; it is
 * the evidence the budget ledger consumes, never a mutable counter.
 */
export interface AttemptUsageRecordedPayload {
  readonly attemptId: string;
  readonly usage: TokenUsagePayload;
}

/** Non-terminal failure of an attempt that schedules a bounded retry. */
export interface AttemptRetryScheduledPayload {
  readonly attemptId: string;
  readonly nextOrdinal: number;
  readonly delayMs: number;
  readonly dueAt: string;
}

export interface TaskRunWaitingPayload {
  readonly reason: WaitingReason;
}

export interface CheckpointRequestedPayload {
  readonly checkpointId: string;
  readonly attemptId: string | null;
}

export interface CheckpointCommittedPayload {
  readonly checkpointId: string;
  readonly eventPosition: number;
}

export interface TaskRunReconcilingPayload {
  readonly reason: WaitingReason;
}

export interface TaskRunCancellingPayload {
  readonly cause: string;
}

export interface TaskRunCancelledPayload {
  readonly cleanup: 'completed' | 'forced';
}

export interface TaskRunSucceededPayload {
  readonly summary: string;
  readonly attemptId: string;
}

export interface TaskRunFailedPayload {
  readonly failure: FailureInfo;
  readonly attemptId: string | null;
}

export interface TaskRunBudgetExhaustedPayload {
  readonly dimension: string;
  readonly limit: number;
  readonly consumed: number;
}

export interface TaskRunPolicyDeniedPayload {
  readonly capability: string;
  readonly reason: string;
}

/**
 * Per-event-type payload map. Every type is versioned by
 * `TASK_RUN_SCHEMA_VERSION`; a shape change requires a new version.
 */
export interface TaskRunEventPayloads {
  'task_run.created': TaskRunCreatedPayload;
  'task_run.queued': Record<string, never>;
  'task_run.admitted': Record<string, never>;
  'attempt.started': AttemptStartedPayload;
  'attempt.usage_recorded': AttemptUsageRecordedPayload;
  'attempt.model_request_started': StartModelRequestPayload;
  'attempt.model_request_settled': SettleModelRequestPayload;
  'task_run.waiting': TaskRunWaitingPayload;
  'task_run.resumed': Record<string, never>;
  'attempt.retry_scheduled': AttemptRetryScheduledPayload;
  'task_run.checkpointing': CheckpointRequestedPayload;
  'checkpoint.committed': CheckpointCommittedPayload;
  'task_run.reconciling': TaskRunReconcilingPayload;
  'task_run.reconciled': Record<string, never>;
  'task_run.reconciliation_failed': FailureInfo;
  'task_run.cancelling': TaskRunCancellingPayload;
  'task_run.cancelled': TaskRunCancelledPayload;
  'task_run.succeeded': TaskRunSucceededPayload;
  'task_run.failed': TaskRunFailedPayload;
  'task_run.budget_exhausted': TaskRunBudgetExhaustedPayload;
  'task_run.policy_denied': TaskRunPolicyDeniedPayload;
}

export type TaskRunEventType = keyof TaskRunEventPayloads;

export type TaskRunEvent = {
  [TType in TaskRunEventType]: EventEnvelope<TType, TaskRunEventPayloads[TType]>;
}[TaskRunEventType];

export type TaskRunEventDraft = {
  [TType in TaskRunEventType]: EventDraft<TType, TaskRunEventPayloads[TType]>;
}[TaskRunEventType];

/** Construct a draft with the domain defaults for version, actor and sensitivity. */
export function draft<TType extends TaskRunEventType>(
  type: TType,
  payload: TaskRunEventPayloads[TType],
  options: {
    readonly actor: Actor;
    readonly causationId?: string | null;
    readonly sensitivity?: Sensitivity;
  },
): EventDraft<TType, TaskRunEventPayloads[TType]> {
  return {
    type,
    payload,
    actor: options.actor,
    causationId: options.causationId ?? null,
    sensitivity: options.sensitivity ?? 'internal',
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
  };
}
