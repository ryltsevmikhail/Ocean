/**
 * Elicitation authority: only the SDK's own approval gate may be accepted, and
 * only while it names a dispatch this host is currently running.
 *
 * Ocean journals owner consent for the exact call, so the SDK's `source: "policy"`
 * request is a confirmation of that call, never an independent permission. An
 * unbound "policy" request (no matching in-flight dispatch) and anything a tool
 * asks for mid-call are declined. Split from `sdk-boundary.ts` so that module
 * stays inside the source-size cap and the negative cases are unit-testable.
 */
import { canonicalJson, toServicePluginJson } from './json.js';

/** Stable key for one in-flight dispatch (address + canonical arguments). */
export function dispatchBindingKey(address: unknown, args: unknown): string | null {
  if (typeof address !== 'string') return null;
  const converted = toServicePluginJson(args);
  if (converted.lossy) return null;
  return `${address}\u0000${canonicalJson(converted.value)}`;
}

/** Accept only `source: "policy"` for an address+args pair in flight in this host. */
export function elicitationAccepted(
  record: Readonly<Record<string, unknown>>,
  inFlight: ReadonlyMap<string, number>,
): boolean {
  const key = dispatchBindingKey(record['address'], record['args']);
  return record['source'] === 'policy' && key !== null && (inFlight.get(key) ?? 0) > 0;
}
