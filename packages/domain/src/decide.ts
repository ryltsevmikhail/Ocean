/**
 * Command decisions.
 *
 * `decide` turns an accepted command into the exact events it commits. It never
 * mutates state: the caller appends the drafts to the log and then evolves.
 */

import type { AnyCommand, CommandType } from './commands.js';
import { DomainError, err, ok, type Result } from './errors.js';
import { ID_PREFIX, isValidId, policyId as brandPolicyId } from './ids.js';
import { draft, type TaskRunEventDraft } from './events.js';
import { createBudget } from './budget.js';
import { COMMAND_SOURCES, isTerminal, type TaskRunAggregate, type TaskRunState } from './state.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function allowedFrom(command: CommandType, aggregate: TaskRunAggregate): boolean {
  if (aggregate.status === 'absent') return command === 'CreateTaskRun';
  return (COMMAND_SOURCES[command] as readonly string[]).includes(aggregate.status);
}

function requireRunningAttempt(state: TaskRunState, attemptRef: string): Result<null> {
  const active = state.activeAttempt;
  if (active === null) {
    return err(DomainError.invariant('command references an attempt but no attempt is active'));
  }
  if (active.attemptId !== attemptRef) {
    return err(
      DomainError.invariant('command references a non-active attempt', {
        active: active.attemptId,
        referenced: attemptRef,
      }),
    );
  }
  return ok(null);
}

/**
 * Decide the events produced by a command.
 *
 * Order of checks is intentional: terminal immutability first (a terminal run
 * never accepts anything), then expected-version fencing, then the transition
 * table, then payload validation.
 */
export function decide(
  aggregate: TaskRunAggregate,
  command: AnyCommand,
): Result<readonly TaskRunEventDraft[]> {
  if (aggregate.status !== 'absent' && isTerminal(aggregate.status)) {
    return err(DomainError.terminal(aggregate.status, command.type));
  }
  if (aggregate.status !== 'absent' && command.taskRunId !== aggregate.id) {
    return err(
      DomainError.invalidArgument(
        `command targets ${command.taskRunId} but the aggregate is ${aggregate.id}`,
      ),
    );
  }
  if (command.expectedVersion !== aggregate.version) {
    return err(DomainError.versionConflict(command.expectedVersion, aggregate.version));
  }
  if (!allowedFrom(command.type, aggregate)) {
    const from = aggregate.status === 'absent' ? 'absent' : aggregate.status;
    return err(DomainError.invalidTransition(from, command.type));
  }

  const events = buildEvents(aggregate, command);
  if (!events.ok) return events;
  return events;
}

function buildEvents(
  aggregate: TaskRunAggregate,
  command: AnyCommand,
): Result<readonly TaskRunEventDraft[]> {
  const actor = command.actor;
  const base = { actor, causationId: command.commandId };

  switch (command.type) {
    case 'CreateTaskRun': {
      const p = command.payload;
      if (p.model.trim() === '') return err(DomainError.invalidArgument('model must not be empty'));
      if (!isValidId(p.policyId, ID_PREFIX.policy)) {
        return err(
          DomainError.invalidArgument(
            `policyId must match ${ID_PREFIX.policy}_<id>, received ${JSON.stringify(p.policyId)}`,
          ),
        );
      }
      return ok([
        draft(
          'task_run.created',
          {
            conversationId: p.conversationId,
            workspaceId: p.workspaceId,
            parentTaskRunId: p.parentTaskRunId,
            model: p.model,
            policyId: brandPolicyId(p.policyId),
            budget: p.budget,
          },
          base,
        ),
      ]);
    }
    case 'Admit':
      return ok([draft('task_run.queued', {}, base)]);
    case 'Schedule':
      return ok([draft('task_run.admitted', {}, base)]);
    case 'StartAttempt': {
      if (aggregate.status === 'absent')
        return err(DomainError.invalidTransition('absent', 'StartAttempt'));
      const p = command.payload;
      if (p.attemptId.trim() === '') {
        return err(DomainError.invalidArgument('attemptId must not be empty'));
      }
      return ok([
        draft(
          'attempt.started',
          {
            attemptId: p.attemptId,
            ordinal: aggregate.attemptCount + 1,
            reason: p.reason,
            provider: p.provider,
            model: p.model,
          },
          base,
        ),
      ]);
    }
    case 'RecordUsage': {
      if (aggregate.status === 'absent') {
        return err(DomainError.invalidTransition('absent', 'RecordUsage'));
      }
      const p = command.payload;
      const checked = requireRunningAttempt(aggregate, p.attemptId);
      if (!checked.ok) return checked;
      if (
        !Number.isInteger(p.usage.inputTokens) ||
        p.usage.inputTokens < 0 ||
        !Number.isInteger(p.usage.outputTokens) ||
        p.usage.outputTokens < 0 ||
        !Number.isInteger(p.usage.totalTokens) ||
        p.usage.totalTokens < 0
      ) {
        return err(DomainError.invalidArgument('usage token counts must be non-negative integers'));
      }

      const events: TaskRunEventDraft[] = [
        draft('attempt.usage_recorded', { attemptId: p.attemptId, usage: { ...p.usage } }, base),
      ];
      // A finite token limit that actual usage crosses is a durable terminal
      // fact (ADR-0012): the settlement and the exhaustion commit together.
      const limit = aggregate.budget.limits.provider_tokens;
      const consumed = aggregate.budget.consumed.provider_tokens + p.usage.totalTokens;
      if (limit !== null && consumed > limit) {
        events.push(
          draft(
            'task_run.budget_exhausted',
            { dimension: 'provider_tokens', limit, consumed },
            base,
          ),
        );
      }
      return ok(events);
    }
    case 'Wait':
      return ok([draft('task_run.waiting', { reason: command.payload.reason }, base)]);
    case 'Resume':
      return ok([draft('task_run.resumed', {}, base)]);
    case 'Retry': {
      if (aggregate.status === 'absent')
        return err(DomainError.invalidTransition('absent', 'Retry'));
      const p = command.payload;
      if (!Number.isFinite(p.delayMs) || p.delayMs < 0) {
        return err(DomainError.invalidArgument('retry delay must be finite and >= 0'));
      }
      if (!ISO_UTC.test(p.dueAt)) {
        return err(DomainError.invalidArgument('retry dueAt must be an ISO-8601 UTC timestamp'));
      }
      return ok([
        draft(
          'attempt.retry_scheduled',
          {
            attemptId: p.attemptId,
            nextOrdinal: aggregate.attemptCount + 1,
            delayMs: p.delayMs,
            dueAt: p.dueAt,
          },
          base,
        ),
      ]);
    }
    case 'BeginCheckpoint': {
      const p = command.payload;
      if (p.checkpointId.trim() === '') {
        return err(DomainError.invalidArgument('checkpointId must not be empty'));
      }
      return ok([draft('task_run.checkpointing', { ...p }, base)]);
    }
    case 'CommitCheckpoint': {
      if (aggregate.status === 'absent') {
        return err(DomainError.invalidTransition('absent', 'CommitCheckpoint'));
      }
      const p = command.payload;
      if (aggregate.pendingCheckpointId !== p.checkpointId) {
        return err(
          DomainError.invariant('checkpoint commit does not match the pending checkpoint', {
            pending: aggregate.pendingCheckpointId,
            committed: p.checkpointId,
          }),
        );
      }
      if (
        !Number.isInteger(p.eventPosition) ||
        p.eventPosition < 1 ||
        p.eventPosition > aggregate.version
      ) {
        return err(
          DomainError.invariant('checkpoint must reference a committed event position', {
            eventPosition: p.eventPosition,
            committedThrough: aggregate.version,
          }),
        );
      }
      return ok([draft('checkpoint.committed', { ...p }, base)]);
    }
    case 'BeginReconcile':
      return ok([draft('task_run.reconciling', { reason: command.payload.reason }, base)]);
    case 'ResolveReconcile':
      return ok([draft('task_run.reconciled', {}, base)]);
    case 'FailReconcile':
      return ok([draft('task_run.reconciliation_failed', command.payload.failure, base)]);
    case 'RequestCancel':
      return ok([draft('task_run.cancelling', { cause: command.payload.cause }, base)]);
    case 'CompleteCleanup':
      return ok([draft('task_run.cancelled', { cleanup: command.payload.cleanup }, base)]);
    case 'Complete': {
      if (aggregate.status === 'absent')
        return err(DomainError.invalidTransition('absent', 'Complete'));
      const checked = requireRunningAttempt(aggregate, command.payload.attemptId);
      if (!checked.ok) return checked;
      return ok([
        draft(
          'task_run.succeeded',
          { summary: command.payload.summary, attemptId: command.payload.attemptId },
          base,
        ),
      ]);
    }
    case 'Fail': {
      if (aggregate.status === 'absent')
        return err(DomainError.invalidTransition('absent', 'Fail'));
      const p = command.payload;
      if (p.attemptId !== null) {
        const checked = requireRunningAttempt(aggregate, p.attemptId);
        if (!checked.ok) return checked;
      }
      return ok([draft('task_run.failed', { failure: p.failure, attemptId: p.attemptId }, base)]);
    }
    case 'ExhaustBudget':
      return ok([draft('task_run.budget_exhausted', { ...command.payload }, base)]);
    case 'DenyPolicy':
      return ok([draft('task_run.policy_denied', { ...command.payload }, base)]);
  }
}

/** Convenience for hosts that build an initial budget from creation input. */
export function initialBudget(
  limits: Parameters<typeof createBudget>[0],
): ReturnType<typeof createBudget> {
  return createBudget(limits);
}
