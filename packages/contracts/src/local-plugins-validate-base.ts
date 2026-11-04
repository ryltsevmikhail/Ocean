/**
 * Shared field validators for the local-runtime plugin contract.
 * No validator accepts a credential VALUE where a reference name is required.
 */

import { localRuntimeRecord } from './local-runtime.js';

export const record = localRuntimeRecord;
export const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
export const optionalBounded = (value: unknown, max: number): boolean =>
  value === undefined || bounded(value, max);
export const position = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const strings = (value: unknown, max: number): value is readonly string[] =>
  Array.isArray(value) && value.length <= max && value.every((entry) => bounded(entry, 128));
export const sha = (value: unknown): value is string => typeof value === 'string' && digest(value);
export const pluginId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
export const version = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/.test(value);
export const connectionName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
export const credentialReference = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value);

export function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const names = Object.keys(value);
  return names.length === keys.length && names.every((name) => keys.includes(name));
}
