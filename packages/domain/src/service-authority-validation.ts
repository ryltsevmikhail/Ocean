/** Small validation helpers private to the neutral authority contracts. */
import { validConversationText } from './conversations.js';
export const authorityText = (v: unknown, max = 128): v is string =>
  typeof v === 'string' && validConversationText(v, max);
export const authorityRevision = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 1;
export const authorityObject = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export function authorityKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
}
export const authorityInstant = (v: unknown): v is string =>
  authorityText(v, 32) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export function authorityNames(v: unknown, max = 256): v is readonly string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= max &&
    v.every((n) => authorityText(n)) &&
    new Set(v).size === v.length
  );
}
export function authorityBoundedJson(v: unknown, max: number): boolean {
  try {
    return validConversationText(JSON.stringify(v), max);
  } catch {
    return false;
  }
}
