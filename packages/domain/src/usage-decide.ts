import type { Command } from './commands.js';
import { DomainError, err, ok, type Result } from './errors.js';
import { draft, type Actor, type TaskRunEventDraft } from './events.js';
import type { TaskRunState } from './state.js';

export function usageExhaustion(
  state: TaskRunState,
  totalTokens: number,
  base: { actor: Actor; causationId: string },
): readonly TaskRunEventDraft[] {
  const limit = state.budget.limits.provider_tokens;
  const consumed = state.budget.consumed.provider_tokens + totalTokens;
  return limit !== null && consumed > limit
    ? [draft('task_run.budget_exhausted', { dimension: 'provider_tokens', limit, consumed }, base)]
    : [];
}
/** Preserve legacy validation and repeated-report semantics. */
export function decideUsage(
  state: TaskRunState,
  command: Command<'RecordUsage'>,
): Result<readonly TaskRunEventDraft[]> {
  const p = command.payload;
  const active = state.activeAttempt;
  if (active === null) {
    return err(DomainError.invariant('command references an attempt but no attempt is active'));
  }
  if (active.attemptId !== p.attemptId) {
    return err(
      DomainError.invariant('command references a non-active attempt', {
        active: active.attemptId,
        referenced: p.attemptId,
      }),
    );
  }
  if (
    [p.usage.inputTokens, p.usage.outputTokens, p.usage.totalTokens].some(
      (v) => !Number.isInteger(v) || v < 0,
    )
  ) {
    return err(DomainError.invalidArgument('usage token counts must be non-negative integers'));
  }
  const base = { actor: command.actor, causationId: command.commandId };
  return ok([
    draft('attempt.usage_recorded', { attemptId: p.attemptId, usage: { ...p.usage } }, base),
    ...usageExhaustion(state, p.usage.totalTokens, base),
  ]);
}
