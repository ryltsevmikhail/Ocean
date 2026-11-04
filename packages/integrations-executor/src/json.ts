/**
 * JSON helpers for the transport boundary.
 *
 * The application port carries plain JSON only. Everything the SDK hands back
 * is `unknown`, so it is converted here exactly once, with a canonical form
 * used for digests and byte-size limits. The canonical form sorts object keys
 * and tool entries, so an unchanged catalog always yields the same digest.
 */
import { createHash } from 'node:crypto';

import type { ServicePluginJson } from '@runnets/application';

export interface JsonConversion {
  /** Canonical JSON value. */
  readonly value: ServicePluginJson;
  /** True when non-JSON data had to be replaced by a safe string projection. */
  readonly lossy: boolean;
}

/**
 * Convert an arbitrary SDK value into a JSON value without throwing.
 *
 * JSON.stringify/parse is used as the definition of JSON; values it cannot
 * represent (functions, symbols, bigint, cycles) become a bounded string
 * projection and set `lossy`, so callers can fail closed where the exact
 * payload matters.
 */
export function toServicePluginJson(input: unknown): JsonConversion {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = undefined;
  }
  if (serialized !== undefined) {
    const parsed: unknown = JSON.parse(serialized);
    return { value: parsed as ServicePluginJson, lossy: false };
  }
  const projected = projectUnrepresentable(input, new Set<object>());
  return { value: projected, lossy: true };
}

function projectUnrepresentable(input: unknown, seen: Set<object>): ServicePluginJson {
  switch (typeof input) {
    case 'string':
    case 'boolean':
      return input;
    case 'number':
      return Number.isFinite(input) ? input : null;
    case 'bigint':
      return String(input);
    case 'undefined':
    case 'symbol':
    case 'function':
      return null;
    case 'object': {
      if (input === null) return null;
      if (seen.has(input)) return '[circular]';
      seen.add(input);
      if (Array.isArray(input)) {
        return input.map((entry) => projectUnrepresentable(entry, seen));
      }
      const result: Record<string, ServicePluginJson> = {};
      for (const [key, value] of Object.entries(input)) {
        result[key] = projectUnrepresentable(value, seen);
      }
      return result;
    }
    default:
      return null;
  }
}

/** Deterministic JSON: object keys sorted, array order preserved. */
export function canonicalJson(value: ServicePluginJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalJson(entry as ServicePluginJson));
    return `[${entries.join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as { [key: string]: ServicePluginJson })[key] as ServicePluginJson)}`,
  );
  return `{${entries.join(',')}}`;
}

/** sha256 hex of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** UTF-8 byte length of `text`. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
