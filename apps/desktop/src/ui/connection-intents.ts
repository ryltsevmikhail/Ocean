import type { LocalModelConnectionMetadata } from '../model-protocol.js';
import { shallowReactive } from 'vue';
import type { PendingConnectionMutation } from './model-settings-recovery.js';
/** Closed keyless commands contain only scalar fields, with omission distinct from null. */
export function sameConnectionIntent(
  a: PendingConnectionMutation,
  b: PendingConnectionMutation,
): boolean {
  const fields = (pending: PendingConnectionMutation) => {
    const command = pending.command;
    const input = 'input' in command ? command.input : command;
    return [
      pending.connectionId,
      pending.requiresKey,
      command.op,
      Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
    ];
  };
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}
export function createConnectionIntents() {
  const entries = shallowReactive(new Map<string, PendingConnectionMutation>());
  function accepts(original: PendingConnectionMutation) {
    const current = entries.get(original.connectionId);
    return !current || sameConnectionIntent(current, original);
  }
  function retain(original: PendingConnectionMutation) {
    if (accepts(original)) entries.set(original.connectionId, original);
  }
  function acknowledge(original: PendingConnectionMutation) {
    const current = entries.get(original.connectionId);
    if (current && sameConnectionIntent(current, original)) entries.delete(original.connectionId);
  }
  return { entries, accepts, retain, acknowledge };
}

export function keylessRecoveryForSelection(
  pending: PendingConnectionMutation,
  entry: LocalModelConnectionMetadata | undefined,
  selected: string,
): boolean {
  if (pending.connectionId !== selected || (entry && entry.connectionId !== selected)) return false;
  if (!entry?.recovery) return true;
  if (entry.recovery.kind !== 'original_input_required') return false;
  const command = pending.command;
  const requestId = 'input' in command ? command.input.requestId : command.requestId;
  return entry.recovery.requestId === requestId;
}
