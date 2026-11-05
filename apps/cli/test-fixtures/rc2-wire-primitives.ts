/** Pinned RC2 primitives from 5e10ec32179063be78a55f6835866a1a864991ac: local-runtime.ts. */
export const LOCAL_RUNTIME_MAX_PAGE = 200;
export const LOCAL_RUNTIME_MAX_WAIT_MS = 30_000;
export function localRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
