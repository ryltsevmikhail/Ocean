/**
 * Outcome classification for one dispatch attempt.
 *
 * The transport adapter owns the one place where "did it happen?" is decided,
 * and it is deliberately pessimistic:
 *
 * - a failed/aborted/timed-out dispatch is ALWAYS `uncertain` and is never
 *   retried; the SDK cannot prove whether the upstream applied the effect
 *   before the response was lost (a response dropped after a server-side write
 *   is the canonical case),
 * - a returned tool result is `observed` when it is a definite answer: success,
 *   a 4xx rejection (including an auth wall), or a protocol-level tool error
 *   that completed the round trip,
 * - a returned transport failure (`upstream_unreachable`) or a 5xx is
 *   `uncertain`, because the upstream may have performed the write before the
 *   failure was observed,
 * - unknown vendor error codes without a status are `uncertain` (fail closed).
 *
 * `not_started` is produced only by the adapter's own pre-dispatch checks or
 * its HTTP counter proving that catalog recovery was blocked before dispatch;
 * it is never inferred from an SDK error tag.
 */
import type { ServicePluginInvokeOutcome, ServicePluginJson } from '@runnets/application';

import { toServicePluginJson } from './json.js';

/** Plain shape of one `executor.execute` attempt, produced by the host seam. */
export type ExecutorDispatchExit =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly outcome: 'timeout' | 'interrupted' | 'failure' | 'not_started';
      readonly tag: string;
    };

/** Vendor tool-error codes that prove the upstream rejected the request. */
const SAFE_VENDOR_CODES: ReadonlySet<string> = new Set([
  'connection_rejected',
  'connection_value_missing',
  'oauth_connection_missing',
  'oauth_refresh_failed',
  'oauth_reauth_required',
  'oauth_scope_insufficient',
  'unknown_arguments',
  'invalid_arguments',
  'mcp_tool_error',
]);

interface VendorFailure {
  readonly code: string;
  readonly status: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recognize the pinned SDK's tool-result envelope. A non-envelope value is a
 * raw business result. The shape is tiny and stable (`ok` discriminant plus
 * `data` / `error`), so no SDK type is imported at the port boundary.
 */
function readToolResult(
  value: unknown,
):
  | { readonly kind: 'data'; readonly data: unknown }
  | { readonly kind: 'vendor'; readonly failure: VendorFailure }
  | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) return { kind: 'data', data: value.data };
  if (value.ok !== false || !isRecord(value.error)) return null;
  const code = typeof value.error.code === 'string' ? value.error.code : 'unknown_vendor_error';
  const rawStatus = value.error.status;
  const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) ? rawStatus : null;
  return { kind: 'vendor', failure: { code, status } };
}

function observedResult(
  invocationId: string,
  result: ServicePluginJson,
  vendorErrorCode: string | null,
): ServicePluginInvokeOutcome {
  return vendorErrorCode === null
    ? { kind: 'observed', invocationId, code: 'ok', result, vendorErrorCode: null }
    : { kind: 'observed', invocationId, code: 'vendor_error', result, vendorErrorCode };
}

function uncertain(
  invocationId: string,
  code:
    | 'deadline_exceeded'
    | 'interrupted'
    | 'transport_failure'
    | 'upstream_failure'
    | 'internal_failure',
  detail: string,
): ServicePluginInvokeOutcome {
  return { kind: 'uncertain', invocationId, code, detail };
}

/** Classify one completed `executor.execute` attempt. Never retries. */
export function classifyDispatchExit(
  invocationId: string,
  exit: ExecutorDispatchExit,
): ServicePluginInvokeOutcome {
  if (!exit.ok) {
    switch (exit.outcome) {
      case 'not_started':
        return {
          kind: 'not_started',
          invocationId,
          code: 'catalog_unavailable',
          detail: 'Catalog discovery required; no business request was sent.',
        };
      case 'timeout':
        return uncertain(
          invocationId,
          'deadline_exceeded',
          'dispatch exceeded the per-call deadline',
        );
      case 'interrupted':
        return uncertain(
          invocationId,
          'interrupted',
          'dispatch was interrupted before a result arrived',
        );
      case 'failure':
        // The tag is a class name (no payload), safe to log; no upstream text.
        return uncertain(
          invocationId,
          'transport_failure',
          `dispatch failed after it was attempted (${exit.tag})`,
        );
    }
  }

  const conversion = toServicePluginJson(exit.value);
  const toolResult = readToolResult(exit.value);
  if (toolResult === null) return observedResult(invocationId, conversion.value, null);

  if (toolResult.kind === 'data') {
    const data = toServicePluginJson(toolResult.data);
    return observedResult(invocationId, data.value, null);
  }

  const { code, status } = toolResult.failure;
  if (status !== null && status >= 500) {
    return uncertain(
      invocationId,
      'upstream_failure',
      `upstream answered ${status} after the request was sent`,
    );
  }
  if (status !== null && status >= 400) {
    return observedResult(invocationId, conversion.value, code.slice(0, 80));
  }
  if (SAFE_VENDOR_CODES.has(code)) {
    return observedResult(invocationId, conversion.value, code.slice(0, 80));
  }
  // Unknown transport-ish vendor failures (`upstream_unreachable`, timeouts,
  // rate limiter envelopes, future codes) may hide a dispatched effect.
  return uncertain(
    invocationId,
    'transport_failure',
    `upstream reported "${code.slice(0, 80)}" without a definite status`,
  );
}
