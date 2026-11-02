/**
 * Turn lifecycle helpers.
 *
 * Every state change is a committed command, and helpers re-read the aggregate
 * after each commit so callers always act on committed state. Ordering is
 * deliberate (ADR-0012): usage settlement is committed before a run fails,
 * completes or is cancelled, so a budget overrun becomes durable evidence
 * instead of a lost reply.
 */

import type { StopReason } from './turn-update.js';
import {
  DomainError,
  available,
  isTerminal,
  type CommandPayloads,
  type CommandType,
  type FailureInfo,
  type TaskRunState,
  type TokenUsagePayload,
} from '@runnets/domain';

import { executeStep } from './commands.js';
import type { TurnInput, TurnOutcome } from './types.js';

const PROTECTED_DIMENSION = 'provider_tokens';
const SUMMARY_LIMIT = 200;
const MESSAGE_LIMIT = 500;

export interface StartedTurn {
  readonly state: TaskRunState;
  readonly attemptId: string;
}

/** Current committed state; a session without events is a host bug. */
export async function stateOf(input: TurnInput): Promise<TaskRunState> {
  const aggregate = await input.service.state(input.taskRunId);
  if (aggregate.status === 'absent') {
    throw new DomainError(
      'invalid_argument',
      `task run ${input.taskRunId} has no committed events`,
    );
  }
  return aggregate;
}

/** Commit one command at the version just observed and emit the new status. */
export async function commit<TType extends CommandType>(
  input: TurnInput,
  type: TType,
  payload: CommandPayloads[TType],
): Promise<TaskRunState> {
  const before = await stateOf(input);
  const result = await executeStep(input.service, input.taskRunId, type, payload, before.version);
  if (!result.ok) throw result.error;
  const after = await stateOf(input);
  input.emit({ sessionUpdate: 'current_mode_update', currentModeId: after.status });
  return after;
}

/** Admit, schedule and start the attempt if the run has not started yet. */
export async function beginAttempt(input: TurnInput): Promise<StartedTurn> {
  let state = await stateOf(input);
  if (state.status === 'created') state = await commit(input, 'Admit', {});
  if (state.status === 'queued') state = await commit(input, 'Schedule', {});
  if (state.status !== 'admitted' && state.status !== 'retrying') {
    throw new DomainError('invalid_transition', `cannot start a turn from state ${state.status}`);
  }
  const attemptId = `${input.taskRunId}_at_${String(state.attemptCount + 1).padStart(4, '0')}`;
  state = await commit(input, 'StartAttempt', {
    attemptId,
    reason: state.attemptCount === 0 ? 'initial' : 'retry',
    provider: input.provider?.id ?? 'runnets',
    model: input.model,
  });
  return { state, attemptId };
}

export function emitText(
  input: TurnInput,
  kind: 'agent_message_chunk' | 'agent_thought_chunk',
  text: string,
): void {
  if (text === '') return;
  input.emit({ sessionUpdate: kind, content: { type: 'text', text } });
}

/** A finite token limit with no capacity left blocks the next dispatch. */
export function hasTokenCapacity(state: TaskRunState): boolean {
  if (state.budget.limits.provider_tokens === null) return true;
  return available(state.budget, PROTECTED_DIMENSION) > 0;
}

/** Commit usage evidence; a finite overrun makes the run terminal. */
export async function settleUsage(
  input: TurnInput,
  attemptId: string,
  usage: TokenUsagePayload | null,
): Promise<TaskRunState> {
  if (usage === null) return stateOf(input);
  return commit(input, 'RecordUsage', { attemptId, usage });
}

/** Settle usage without letting a settlement failure hide the real outcome. */
export async function settleUsageSafely(
  input: TurnInput,
  attemptId: string,
  usage: TokenUsagePayload | null,
): Promise<void> {
  try {
    await settleUsage(input, attemptId, usage);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
}

export async function failRun(input: TurnInput, attemptId: string, message: string): Promise<void> {
  const failure: FailureInfo = { code: 'provider_error', message: bounded(message) };
  await commit(input, 'Fail', { failure, attemptId });
}

export async function completeRun(
  input: TurnInput,
  attemptId: string,
  text: string,
  stopReason: StopReason,
): Promise<TurnOutcome> {
  const state = await stateOf(input);
  if (isTerminal(state.status)) return failedOutcome(budgetText(state));
  const trimmed = text.trim();
  const summary = trimmed === '' ? 'turn completed' : trimmed.slice(0, SUMMARY_LIMIT);
  await input.beforeComplete?.(text, stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn');
  await commit(input, 'Complete', { summary, attemptId });
  return { kind: 'completed', stopReason, text };
}

/** Settle usage first: cancellation must not lose committed usage evidence. */
export async function cancelRun(
  input: TurnInput,
  attemptId: string,
  usage: TokenUsagePayload | null,
  text: string,
  quiescent: boolean,
): Promise<TurnOutcome> {
  await settleUsageSafely(input, attemptId, usage);
  let state = await stateOf(input);
  if (isTerminal(state.status))
    return state.status === 'cancelled'
      ? { kind: 'cancelled', stopReason: 'cancelled', text }
      : failedOutcome(budgetText(state));
  if (state.status !== 'cancelling')
    state = await commit(input, 'RequestCancel', { cause: 'client cancelled' });
  if (state.status === 'cancelling' && quiescent)
    await commit(input, 'CompleteCleanup', { cleanup: 'completed' });
  if (!quiescent && state.status === 'cancelling') {
    const message =
      'cancellation pending; provider completion and billing may be unknown; reconcile before confirming cleanup';
    emitText(input, 'agent_message_chunk', message);
    return { kind: 'uncertain', stopReason: 'refusal', text: message };
  }
  return { kind: 'cancelled', stopReason: 'cancelled', text };
}

/** Commit settlement, then fail without masking an already-terminal run. */
export async function failWithUsage(
  input: TurnInput,
  attemptId: string,
  usage: TokenUsagePayload | null,
  message: string,
): Promise<TurnOutcome> {
  await settleUsageSafely(input, attemptId, usage);
  const state = await stateOf(input);
  if (!isTerminal(state.status)) {
    try {
      await failRun(input, attemptId, message);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return failedOutcome(message);
}

export async function exhaustedRun(input: TurnInput, state: TaskRunState): Promise<TurnOutcome> {
  const limit = state.budget.limits.provider_tokens;
  const consumed = state.budget.consumed.provider_tokens;
  if (limit !== null) {
    await commit(input, 'ExhaustBudget', { dimension: PROTECTED_DIMENSION, limit, consumed });
  }
  const message = `budget exhausted: ${PROTECTED_DIMENSION} ${consumed}/${limit ?? 'unlimited'}`;
  emitText(input, 'agent_message_chunk', message);
  return failedOutcome(message);
}

/** No provider configured: keep the deterministic lifecycle and say so. */
export async function deterministicRun(input: TurnInput, attemptId: string): Promise<TurnOutcome> {
  const summary = `TaskRun ${input.taskRunId}: deterministic turn (no provider configured)`;
  emitText(input, 'agent_message_chunk', summary);
  return completeRun(input, attemptId, summary, 'end_turn');
}

export function failedOutcome(text: string): TurnOutcome {
  return { kind: 'failed', stopReason: 'refusal', text };
}

export function budgetText(state: TaskRunState): string {
  const summary = state.terminal?.summary ?? null;
  return summary === null ? `turn stopped: run is ${state.status}` : `turn stopped: ${summary}`;
}

/** Collapse and bound untrusted text before it reaches an event or a client. */
export function bounded(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return 'provider turn failed';
  return collapsed.length > MESSAGE_LIMIT ? `${collapsed.slice(0, MESSAGE_LIMIT)}...` : collapsed;
}

/** Preserve uncertain effects as nonterminal evidence; cancellation never confirms cleanup. */
export async function uncertainRun(input: TurnInput, text: string): Promise<TurnOutcome> {
  const state = await stateOf(input);
  emitText(input, 'agent_message_chunk', text);
  if (!isTerminal(state.status) && input.signal.aborted && state.status !== 'cancelling') {
    await commit(input, 'RequestCancel', { cause: 'client cancelled' });
  } else if (
    !isTerminal(state.status) &&
    state.status !== 'cancelling' &&
    state.status !== 'reconciling'
  ) {
    await commit(input, 'BeginReconcile', { reason: 'reconciliation' });
  }
  return { kind: 'uncertain', stopReason: 'refusal', text };
}
