import { localRuntimeRecord } from './local-runtime.js';
/** Closed JSON objects only; optional names must be declared explicitly. */
export function modelObject(
  v: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): v is Record<string, unknown> {
  return (
    localRuntimeRecord(v) &&
    required.every((k) => Object.hasOwn(v, k)) &&
    Object.keys(v).every((k) => required.includes(k) || optional.includes(k))
  );
}
export function modelText(v: unknown, max = 256): v is string {
  return (
    typeof v === 'string' &&
    v.trim() !== '' &&
    !/[\0\ud800-\udfff]/u.test(v) &&
    new TextEncoder().encode(v).length <= max
  );
}
export const modelPosition = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const modelPositive = (v: unknown): v is number => modelPosition(v) && v > 0;
export const modelDate = (v: unknown): v is string =>
  modelText(v, 64) && Number.isFinite(Date.parse(v));
export const modelEnum = (v: unknown, choices: readonly (string | null)[]) =>
  choices.some((c) => c === v);
export const modelNullable = (v: unknown, check: (v: unknown) => boolean) => v === null || check(v);
export function modelPageQuery(
  v: unknown,
  required: readonly string[],
  optional: readonly string[],
  cursorBytes: number,
) {
  return (
    modelObject(v, required, [...optional, 'after', 'limit']) &&
    (v['after'] === undefined || modelText(v['after'], cursorBytes)) &&
    (v['limit'] === undefined || (modelPositive(v['limit']) && v['limit'] <= 200))
  );
}
export function modelPage(
  v: unknown,
  scopes: readonly string[],
  check: (v: unknown) => boolean,
  cursorBytes: number,
): v is Record<string, unknown> & { items: unknown[]; nextAfter: string | null } {
  return (
    modelObject(v, ['version', ...scopes, 'items', 'nextAfter']) &&
    v['version'] === 1 &&
    Array.isArray(v['items']) &&
    v['items'].length <= 200 &&
    v['items'].every(check) &&
    modelNullable(v['nextAfter'], (x) => modelText(x, cursorBytes)) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= 2 * 1024 * 1024 - 8192
  );
}
