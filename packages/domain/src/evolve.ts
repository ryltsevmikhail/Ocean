/**
 * Event application.
 *
 * `evolve` is a fold over committed events. It is total over the vocabulary in
 * `events.ts` and throws only when a stream is structurally impossible (an
 * event other than creation applied to an absent aggregate).
 */

import { createBudget } from './budget.js';
import type { EventEnvelope, TaskRunEvent, TaskRunEventType } from './events.js';
import { policyId, type TaskRunId } from './ids.js';
import { ABSENT, isTerminal, type TaskRunAggregate, type TaskRunState } from './state.js';

function apply(state: TaskRunState, event: TaskRunEvent): TaskRunState {
  const next = { ...state, version: event.sequence };

  switch (event.type) {
    case 'task_run.created':
      // Creation is handled by `evolve`; a second creation is a broken stream.
      throw new Error(`task run ${event.aggregateId} already exists`);
    case 'task_run.queued':
      return { ...next, status: 'queued' };
    case 'task_run.admitted':
      return { ...next, status: 'admitted' };
    case 'attempt.started':
      return {
        ...next,
        status: 'running',
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
    case 'attempt.usage_recorded': {
      const { usage } = event.payload;
      const tokens = [usage.inputTokens, usage.outputTokens, usage.totalTokens];
      if (tokens.some((value) => !Number.isInteger(value) || value < 0)) {
        throw new Error(
          `attempt.usage_recorded carries invalid token counts: ${JSON.stringify(usage)}`,
        );
      }
      return {
        ...next,
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
      return { ...next, status: 'waiting', waitingReason: event.payload.reason };
    case 'task_run.resumed':
      return { ...next, status: 'running', waitingReason: null };
    case 'attempt.retry_scheduled':
      return { ...next, status: 'retrying', waitingReason: null };
    case 'task_run.checkpointing':
      return { ...next, status: 'checkpointing', pendingCheckpointId: event.payload.checkpointId };
    case 'checkpoint.committed':
      return {
        ...next,
        status: 'running',
        pendingCheckpointId: null,
        lastCommittedCheckpointId: event.payload.checkpointId,
      };
    case 'task_run.reconciling':
      return { ...next, status: 'reconciling', waitingReason: event.payload.reason };
    case 'task_run.reconciled':
      return { ...next, status: 'running', waitingReason: null };
    case 'task_run.reconciliation_failed':
      return {
        ...next,
        status: 'unrecoverable',
        waitingReason: null,
        terminal: { status: 'unrecoverable', failure: event.payload, summary: null },
      };
    case 'task_run.cancelling':
      return { ...next, status: 'cancelling', cancellationCause: event.payload.cause };
    case 'task_run.cancelled':
      return {
        ...next,
        status: 'cancelled',
        terminal: { status: 'cancelled', failure: null, summary: event.payload.cleanup },
      };
    case 'task_run.succeeded':
      return {
        ...next,
        status: 'succeeded',
        waitingReason: null,
        terminal: { status: 'succeeded', failure: null, summary: event.payload.summary },
      };
    case 'task_run.failed':
      return {
        ...next,
        status: 'failed',
        waitingReason: null,
        terminal: { status: 'failed', failure: event.payload.failure, summary: null },
      };
    case 'task_run.budget_exhausted':
      return {
        ...next,
        status: 'budget_exhausted',
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
        status: 'policy_denied',
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
      status: 'created',
      version: event.sequence,
      conversationId: p.conversationId,
      workspaceId: p.workspaceId,
      parentTaskRunId: p.parentTaskRunId,
      model: p.model,
      policyId: policyId(p.policyId),
      budget: createBudget(p.budget),
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
