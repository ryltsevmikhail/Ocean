import {
  copyModelActivationSnapshot,
  type ModelActivationSnapshot,
  type ModelExecutionLimits,
} from '@runnets/domain';
import type { ProviderPort } from './provider.js';

export const DEFAULT_MODEL_EXECUTION_LIMITS: ModelExecutionLimits = Object.freeze({
  maxModelRequests: 24,
  requestTimeoutMs: 120000,
  turnTimeoutMs: 600000,
});

export function freezeModelActivation(snapshot: ModelActivationSnapshot): ModelActivationSnapshot {
  const copied = copyModelActivationSnapshot(snapshot);
  Object.freeze(copied.identity);
  Object.freeze(copied.capabilities.inputModalities);
  Object.freeze(copied.capabilities);
  Object.freeze(copied.limits);
  return Object.freeze(copied);
}
/** Shared conservative metadata for low-level/ACP and explicitly injected hosts. */
export function hostModelActivation(
  provider: ProviderPort,
  model: string,
  admittedAt: string,
  maxModelRequests = 24,
): ModelActivationSnapshot {
  return freezeModelActivation({
    version: 1,
    identity: { source: 'host', providerId: provider.id, modelId: model },
    capabilities: {
      tools: provider.capabilities.toolCalls === true,
      streaming: provider.capabilities.streaming === true,
      inputModalities: provider.modelInfo?.find((m) => m.id === model)?.inputModalities ?? ['text'],
      contextTokens: null,
      maxOutputTokens: null,
      usage: provider.capabilities.usage === true ? 'reported' : 'unavailable',
    },
    limits: { ...DEFAULT_MODEL_EXECUTION_LIMITS, maxModelRequests },
    admittedAt,
    deadlineAt: new Date(
      Date.parse(admittedAt) + DEFAULT_MODEL_EXECUTION_LIMITS.turnTimeoutMs,
    ).toISOString(),
  });
}
