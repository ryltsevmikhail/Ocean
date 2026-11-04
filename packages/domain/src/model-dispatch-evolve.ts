import type { TaskRunEvent } from './events.js';
import { copyStart, copySettlement } from './model-dispatch-validation.js';
import type { TaskRunState } from './state.js';

/** Model projection only; lifecycle/version and the exact budget ledger remain owned by evolve. */
export function evolveModelDispatch(state: TaskRunState, event: TaskRunEvent): TaskRunState {
  const execution = state.modelExecution;
  if (event.type === 'attempt.model_request_started') {
    const p = copyStart(event.payload);
    return {
      ...state,
      modelExecution: {
        activation: p.activation,
        startedRequests: p.ordinal,
        lastRequest: {
          attemptId: p.attemptId,
          ordinal: p.ordinal,
          startedAt: p.startedAt,
          settlement: null,
        },
        usage:
          execution === null
            ? {
                knownTokens: state.budget.consumed.provider_tokens,
                estimatedTokens: 0,
                unavailableRequests: 0,
              }
            : { ...execution.usage },
      },
    };
  }
  if (event.type === 'attempt.model_request_settled') {
    if (execution === null) throw new Error('model settlement without a model request');
    const p = copySettlement(event.payload),
      usage = p.usage;
    return {
      ...state,
      modelExecution: {
        ...execution,
        lastRequest: { ...execution.lastRequest, settlement: p },
        usage: {
          ...execution.usage,
          estimatedTokens:
            execution.usage.estimatedTokens +
            (usage.kind === 'estimated' ? usage.tokens.totalTokens : 0),
          unavailableRequests:
            execution.usage.unavailableRequests + (usage.kind === 'unavailable' ? 1 : 0),
        },
      },
    };
  }
  if (event.type === 'attempt.usage_recorded' && execution !== null) {
    return {
      ...state,
      modelExecution: {
        ...execution,
        usage: {
          ...execution.usage,
          knownTokens: execution.usage.knownTokens + event.payload.usage.totalTokens,
        },
      },
    };
  }
  return state;
}
