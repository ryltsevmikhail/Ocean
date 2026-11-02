/**
 * Immutable copies of committed values.
 *
 * The adapters hand out frozen deep copies so a caller cannot mutate durable
 * history through an alias. Event payloads are JSON-like by domain contract
 * (plain objects, arrays, primitives, null), so a structural walk is enough.
 */

import type { EventEnvelope } from '@runnets/domain';

/** Deep-copy a JSON-like value and freeze every object and array in the copy. */
export function freezeCopy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    return Object.freeze(items.map((item) => freezeCopy(item)));
  }
  const source = value as Readonly<Record<string, unknown>>;
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) copy[key] = freezeCopy(nested);
  return Object.freeze(copy);
}

/** Freeze one event envelope together with its actor and payload. */
export function frozenEnvelope(envelope: EventEnvelope): EventEnvelope {
  return freezeCopy(envelope) as EventEnvelope;
}
