/**
 * Event application.
 *
 * `evolve` is a fold over committed events. It is total over the vocabulary in
 * `events.ts` and throws only when a stream is structurally impossible (an
 * event other than creation applied to an absent aggregate).
 */

import { evolveModelDispatch } from './model-dispatch-evolve.js';
import { createBudget } from './budget.js';
import type { EventEnvelope, TaskRunEvent, TaskRunEventType } from './events.js';
import { policyId, type TaskRunId } from './ids.js';
import {
  ABSENT,
  isTerminal,
  type TaskRunAggregate,
  type TaskRunState,
  type TaskRunStatus,
} from './state.js';

/** A null transition advances version while preserving status. Shared by replay and bounded reads. */
export const STATUS_AFTER_EVENT = {
  'task_run.created': 'created',
  'task_run.queued': 'queued',
  'task_run.admitted': 'admitted',
  'attempt.started': 'running',
  'attempt.usage_recorded': null,
  'attempt.model_request_started': null,
  'attempt.model_request_settled': null,
  'task_run.waiting': 'waiting',
  'task_run.resumed': 'running',
  'attempt.retry_scheduled': 'retrying',
  'task_run.checkpointing': 'checkpointing',
  'checkpoint.committed': 'running',
  'task_run.reconciling': 'reconciling',
  'task_run.reconciled': 'running',
  'task_run.reconciliation_failed': 'unrecoverable',
  'task_run.cancelling': 'cancelling',
  'task_run.cancelled': 'cancelled',
  'task_run.succeeded': 'succeeded',
  'task_run.failed': 'failed',
  'task_run.budget_exhausted': 'budget_exhausted',
  'task_run.policy_denied': 'policy_denied',
} as const satisfies Record<TaskRunEventType, TaskRunStatus | null>;

function apply(state: TaskRunState, event: TaskRunEvent): TaskRunState {
  const next = {
    ...state,
    version: event.sequence,
    status: STATUS_AFTER_EVENT[event.type] ?? state.status,
  };

  switch (event.type) {
    case 'task_run.created':
      // Creation is handled by `evolve`; a second creation is a broken stream.
      throw new Error(`task run ${event.aggregateId} already exists`);
    case 'task_run.queued':
    case 'task_run.admitted':
      return next;
    case 'attempt.started':
      return {
        ...next,
        activeAttempt: {
          attemptId: event.payload.attemptId,
          ordinal: event.payload.ordinal,
          reason: event.payload.reason,
          provider: event.payload.provider,
          model: event.payload.model,
        },
        attemptCount: event.payload.ordinal,
        waitingReason: null,
      };
    case 'attempt.model_request_started':
    case 'attempt.model_request_settled':
      return evolveModelDispatch(next, event);
    case 'attempt.usage_recorded': {
      const { usage } = event.payload;
      const tokens = [usage.inputTokens, usage.outputTokens, usage.totalTokens];
      if (tokens.some((value) => !Number.isInteger(value) || value < 0)) {
        throw new Error(
          `attempt.usage_recorded carries invalid token counts: ${JSON.stringify(usage)}`,
        );
      }
      return {
        ...evolveModelDispatch(next, event),
        budget: {
          ...state.budget,
          consumed: {
            ...state.budget.consumed,
            provider_tokens: state.budget.consumed.provider_tokens + usage.totalTokens,
          },
        },
      };
    }
    case 'task_run.waiting':
      return { ...next, waitingReason: event.payload.reason };
    case 'task_run.resumed':
      return { ...next, waitingReason: null };
    case 'attempt.retry_scheduled':
      return { ...next, waitingReason: null };
    case 'task_run.checkpointing':
      return { ...next, pendingCheckpointId: event.payload.checkpointId };
    case 'checkpoint.committed':
      return {
        ...next,
        pendingCheckpointId: null,
        lastCommittedCheckpointId: event.payload.checkpointId,
      };
    case 'task_run.reconciling':
      return { ...next, waitingReason: event.payload.reason };
    case 'task_run.reconciled':
      return { ...next, waitingReason: null };
    case 'task_run.reconciliation_failed':
      return {
        ...next,
        waitingReason: null,
        terminal: { status: 'unrecoverable', failure: event.payload, summary: null },
      };
    case 'task_run.cancelling':
      return { ...next, cancellationCause: event.payload.cause };
    case 'task_run.cancelled':
      return {
        ...next,
        terminal: { status: 'cancelled', failure: null, summary: event.payload.cleanup },
      };
    case 'task_run.succeeded':
      return {
        ...next,
        waitingReason: null,
        terminal: { status: 'succeeded', failure: null, summary: event.payload.summary },
      };
    case 'task_run.failed':
      return {
        ...next,
        waitingReason: null,
        terminal: { status: 'failed', failure: event.payload.failure, summary: null },
      };
    case 'task_run.budget_exhausted':
      return {
        ...next,
        waitingReason: null,
        terminal: {
          status: 'budget_exhausted',
          failure: null,
          summary: `${event.payload.dimension}:${event.payload.consumed}/${event.payload.limit}`,
        },
      };
    case 'task_run.policy_denied':
      return {
        ...next,
        waitingReason: null,
        terminal: {
          status: 'policy_denied',
          failure: null,
          summary: `${event.payload.capability}:${event.payload.reason}`,
        },
      };
    default: {
      const exhaustive: never = event;
      throw new Error(`unhandled TaskRun event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Apply one committed event to the aggregate. */
export function evolve(aggregate: TaskRunAggregate, event: TaskRunEvent): TaskRunAggregate {
  if (event.type === 'task_run.created') {
    if (aggregate.status !== 'absent') {
      throw new Error(`task run ${event.aggregateId} already exists`);
    }
    const p = event.payload;
    const state: TaskRunState = {
      id: event.aggregateId as TaskRunId,
      status: STATUS_AFTER_EVENT['task_run.created'],
      version: event.sequence,
      conversationId: p.conversationId,
      workspaceId: p.workspaceId,
      parentTaskRunId: p.parentTaskRunId,
      model: p.model,
      policyId: policyId(p.policyId),
      budget: createBudget(p.budget),
      modelExecution: null,
      activeAttempt: null,
      attemptCount: 0,
      waitingReason: null,
      pendingCheckpointId: null,
      lastCommittedCheckpointId: null,
      cancellationCause: null,
      terminal: null,
    };
    return state;
  }
  if (aggregate.status === 'absent') {
    throw new Error(`event ${event.type} applied to a task run with no creation event`);
  }
  return apply(aggregate, event);
}

/** Rebuild aggregate state from a committed, ordered stream. */
export function replay(events: readonly EventEnvelope[]): TaskRunAggregate {
  let aggregate: TaskRunAggregate = ABSENT;
  for (const event of events) {
    aggregate = evolve(aggregate, event as TaskRunEvent);
  }
  return aggregate;
}

/** Narrowing helper for callers that know the aggregate was created. */
export function isCreated(aggregate: TaskRunAggregate): aggregate is TaskRunState {
  return aggregate.status !== 'absent';
}

export type { TaskRunEvent, TaskRunEventType, TaskRunAggregate };
export { isTerminal };
