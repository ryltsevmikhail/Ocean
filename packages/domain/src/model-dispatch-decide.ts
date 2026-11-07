import { available } from './budget.js';
import type { Command } from './commands.js';
import { DomainError, err, ok, type Result } from './errors.js';
import { draft, type TaskRunEventDraft } from './events.js';
import { hasMissingModelUsage, hasUnresolvedModelRequest } from './model-dispatch-guards.js';
import {
  copyStart,
  copySettlement,
  copyTokens,
  count,
  requireModel,
  sameActivation,
} from './model-dispatch-validation.js';
import { COMMAND_SOURCES, type TaskRunState } from './state.js';
import { usageExhaustion } from './usage-decide.js';

export function decideModelDispatch(
  state: TaskRunState,
  command: Command<'StartModelRequest'> | Command<'SettleModelRequest'>,
): Result<readonly TaskRunEventDraft[]> {
  const base = { actor: command.actor, causationId: command.commandId };
  try {
    requireModel(
      (COMMAND_SOURCES[command.type] as readonly string[]).includes(state.status),
      'model command requires an allowed lifecycle state',
    );
    if (command.type === 'StartModelRequest') {
      const p = copyStart(command.payload),
        execution = state.modelExecution;
      requireModel(
        state.activeAttempt?.attemptId === p.attemptId,
        'model start references non-active attempt',
      );
      requireModel(
        !hasUnresolvedModelRequest(state) && !hasMissingModelUsage(state),
        'previous model request is not resolved',
      );
      requireModel(
        p.activation.identity.providerId === state.activeAttempt.provider &&
          p.activation.identity.modelId === state.activeAttempt.model,
        'activation does not match attempt',
      );
      requireModel(
        execution === null || sameActivation(execution.activation, p.activation),
        'activation changed',
      );
      requireModel(
        p.ordinal === (execution?.startedRequests ?? 0) + 1 &&
          p.ordinal <= p.activation.limits.maxModelRequests,
        'model request ordinal exceeds frozen bounds',
      );
      const started = Date.parse(p.startedAt);
      requireModel(
        started >= Date.parse(p.activation.admittedAt) &&
          started < Date.parse(p.activation.deadlineAt),
        'model start outside activation deadline',
      );
      const finished = execution?.lastRequest.settlement?.finishedAt;
      requireModel(
        finished === undefined || started >= Date.parse(finished),
        'model start precedes previous finish',
      );
      count(state.budget.consumed.provider_tokens);
      if (state.budget.limits.provider_tokens !== null) {
        requireModel(
          p.activation.capabilities.usage === 'reported' &&
            available(state.budget, 'provider_tokens') > 0,
          'finite token budget requires reported usage and capacity',
        );
      }
      return ok([draft('attempt.model_request_started', p, base)]);
    }
    const p = copySettlement(command.payload),
      execution = state.modelExecution;
    requireModel(
      execution !== null && state.activeAttempt?.attemptId === p.attemptId,
      'model settlement references non-active attempt',
    );
    const last = execution.lastRequest;
    requireModel(
      last.attemptId === p.attemptId && last.ordinal === p.ordinal && last.settlement === null,
      'model settlement does not match pending request',
    );
    requireModel(
      Date.parse(p.finishedAt) >= Date.parse(last.startedAt),
      'model finish precedes start',
    );
    if (p.usage.kind === 'actual')
      count(state.budget.consumed.provider_tokens + p.usage.tokens.totalTokens);
    if (p.usage.kind === 'estimated')
      count(execution.usage.estimatedTokens + p.usage.tokens.totalTokens);
    if (p.usage.kind === 'unavailable') count(execution.usage.unavailableRequests + 1);
    const events: TaskRunEventDraft[] = [draft('attempt.model_request_settled', p, base)];
    if (p.usage.kind === 'actual') {
      events.push(
        draft(
          'attempt.usage_recorded',
          { attemptId: p.attemptId, usage: copyTokens(p.usage.tokens) },
          base,
        ),
      );
      if (p.completion.kind !== 'unknown')
        events.push(...usageExhaustion(state, p.usage.tokens.totalTokens, base));
    }
    if (p.completion.kind === 'unknown' && state.status === 'running') {
      events.push(draft('task_run.reconciling', { reason: 'reconciliation' }, base));
    }
    return ok(events);
  } catch (error) {
    if (error instanceof DomainError) return err(error);
    throw error;
  }
}
