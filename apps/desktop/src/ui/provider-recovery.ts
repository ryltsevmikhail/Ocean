import type { PendingConnectionMutation } from './model-settings-recovery.js';
import type { Command } from '../protocol.js';
export type LegacyMutation = Extract<
  Command,
  { op: 'provider-set' | 'provider-disconnect' | 'provider-remove-key' }
>;
export interface LegacyOriginal {
  readonly command: LegacyMutation;
  readonly requiresKey: boolean;
}
export function legacyOriginal(command: LegacyMutation): LegacyOriginal {
  if (command.op !== 'provider-set') return { command: { ...command }, requiresKey: false };
  const { key, ...input } = command;
  return { command: input, requiresKey: key !== undefined };
}
export function sameLegacyOriginal(a: LegacyOriginal, b: LegacyOriginal): boolean {
  const fields = (original: LegacyOriginal) => [
    original.requiresKey,
    Object.entries(original.command).sort(([a], [b]) => a.localeCompare(b)),
  ];
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}
export function legacyResupply(original: LegacyOriginal, key: string): LegacyMutation {
  if (original.requiresKey && !key.trim()) throw Error('key_resupply_required');
  if (!original.requiresKey && key !== '') throw Error('invalid_request');
  if (original.requiresKey && original.command.op === 'provider-set')
    return { ...original.command, key };
  return { ...original.command };
}

export function compatibleLegacyOriginal(
  original: PendingConnectionMutation | null,
): LegacyOriginal | null {
  if (!original) return null;
  const command = original.command;
  if (
    command.op !== 'provider-set' &&
    command.op !== 'provider-remove-key' &&
    command.op !== 'provider-disconnect'
  )
    return null;
  return { command, requiresKey: original.requiresKey };
}
