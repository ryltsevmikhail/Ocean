import type { AnyCommand } from './commands.js';
import { DomainError, err, ok, type Result } from './errors.js';
import type { TaskRunState } from './state.js';

export function hasUnresolvedModelRequest(state: TaskRunState): boolean {
  const last = state.modelExecution?.lastRequest;
  return (
    last !== undefined &&
    (last.settlement === null || last.settlement.completion.kind === 'unknown')
  );
}
export function hasMissingModelUsage(state: TaskRunState): boolean {
  const execution = state.modelExecution,
    settlement = execution?.lastRequest.settlement;
  return (
    execution?.activation.capabilities.usage === 'reported' &&
    settlement?.completion.kind === 'terminal' &&
    settlement.usage.kind !== 'actual'
  );
}
export function guardModelDispatch(state: TaskRunState, command: AnyCommand): Result<null> {
  if (state.modelExecution === null) return ok(null);
  const type = command.type;
  if (
    hasUnresolvedModelRequest(state) &&
    ([
      'Complete',
      'Fail',
      'Retry',
      'ResolveReconcile',
      'ExhaustBudget',
      'DenyPolicy',
      'FailReconcile',
      'Wait',
      'BeginCheckpoint',
      'StartAttempt',
    ].includes(type) ||
      (type === 'CompleteCleanup' && command.payload?.cleanup !== 'forced'))
  )
    return err(DomainError.invariant('model request completion is unresolved'));
  if (type === 'RecordUsage')
    return err(DomainError.invariant('model settlement owns usage recording'));
  if (hasMissingModelUsage(state) && ['Complete', 'Retry', 'StartModelRequest'].includes(type)) {
    return err(DomainError.invariant('terminal model request lacks expected reported usage'));
  }
  if (
    type === 'Complete' &&
    state.modelExecution.lastRequest.settlement?.completion.kind !== 'terminal'
  ) {
    return err(DomainError.invariant('model request has no successful terminal evidence'));
  }
  if (type === 'Retry' && command.payload.attemptId !== state.activeAttempt?.attemptId) {
    return err(DomainError.invariant('retry references a non-active attempt'));
  }
  return ok(null);
}
