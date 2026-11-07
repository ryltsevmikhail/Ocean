/** Freeze one model identity and its authority for every request in this turn. */
import {
  copyModelActivationSnapshot,
  DomainError,
  type ModelActivationSnapshot,
} from '@runnets/domain';
import { freezeModelActivation, hostModelActivation } from './model-activation-snapshot.js';
import type { TurnInput } from './types.js';

export function modelNow(input: TurnInput): Date {
  return input.clock?.now() ?? new Date();
}

/** Preserve the legacy effective integer call count, refusing malformed authority. */
export function legacyModelRequestLimit(value: number | undefined): number {
  if (value === undefined) return 24;
  if (typeof value !== 'number' || Number.isNaN(value))
    throw DomainError.invalidArgument('invalid maxModelRequests');
  return Math.floor(Math.min(64, Math.max(1, value)));
}

/** Low-level injected/ACP compatibility only; production admission supplies activation. */
export function normalizeModelActivation(input: TurnInput): ModelActivationSnapshot {
  const legacy = legacyModelRequestLimit(input.maxModelRequests);
  let snapshot: ModelActivationSnapshot;
  if (input.activation !== undefined) {
    const copied = copyModelActivationSnapshot(input.activation);
    snapshot = {
      ...copied,
      limits: {
        ...copied.limits,
        maxModelRequests: Math.min(
          copied.limits.maxModelRequests,
          input.maxModelRequests === undefined ? 64 : legacy,
        ),
      },
    };
  } else {
    if (input.provider === null) throw DomainError.invalidArgument('provider is required');
    snapshot = hostModelActivation(
      input.provider,
      input.model,
      modelNow(input).toISOString(),
      legacy,
    );
  }
  if (
    snapshot.identity.providerId !== input.provider?.id ||
    snapshot.identity.modelId !== input.model
  )
    throw DomainError.invalidArgument('activation does not match provider/model');
  return freezeModelActivation(snapshot);
}
