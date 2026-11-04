import { boundedModelText } from './model-connection-input.js';
/** Transport is 2 MiB; reserve 8 KiB for RPC framing/host composition. Application owns no wire dependency. */
export const MODEL_READ_PAGE_BYTES = 2 * 1024 * 1024 - 8192;
export interface ModelReadPageInput {
  readonly after?: string;
  readonly limit?: number;
  /** Host may reduce the serialized result budget, never raise it above the transport reserve. */
  readonly byteBudget?: number;
}
export function modelReadPage(input: ModelReadPageInput, idBytes: number) {
  const after = input.after === undefined ? null : boundedModelText(input.after, idBytes);
  const limit = input.limit ?? 50;
  const byteBudget = input.byteBudget ?? MODEL_READ_PAGE_BYTES;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(byteBudget) ||
    byteBudget < 1 ||
    byteBudget > MODEL_READ_PAGE_BYTES
  )
    throw Error('invalid_params');
  return { after, limit, byteBudget };
}
/** ID keysets are page-local snapshots, never a whole-list snapshot across requests. */
export function boundedModelPage<T, R>(
  rows: readonly T[],
  settings: ReturnType<typeof modelReadPage>,
  id: (row: T) => string,
  project: (row: T) => R,
  scope: object,
) {
  const candidates = [...rows]
    .filter((r) => settings.after === null || id(r) > settings.after)
    .sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
  const items: R[] = [];
  let last: string | null = null;
  const fits = (nextAfter: string | null) =>
    new TextEncoder().encode(JSON.stringify({ ...scope, items, nextAfter })).length <=
    settings.byteBudget;
  if (!fits(null)) throw Error('projection_too_large');
  for (let n = 0; n < candidates.length && n < settings.limit; n++) {
    const row = candidates[n]!;
    items.push(project(row));
    const more = n + 1 < candidates.length;
    if (!fits(more ? id(row) : null)) {
      items.pop();
      if (items.length === 0) throw Error('projection_too_large');
      return { items, nextAfter: last };
    }
    last = id(row);
  }
  return { items, nextAfter: items.length < candidates.length ? last : null };
}
