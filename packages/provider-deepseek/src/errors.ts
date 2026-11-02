/**
 * DeepSeek error normalization.
 *
 * HTTP statuses and vendor error payloads are translated here, so nothing above
 * the adapter branches on a vendor error shape. Provider text is untrusted: it
 * is collapsed, bounded, and never includes request headers or the API key.
 */

import { ProviderError } from '@runnets/provider-core';

import { asRecord } from './wire.js';

const MAX_MESSAGE_LENGTH = 300;
const FIRST_CLIENT_ERROR_STATUS = 400;
const FIRST_SERVER_ERROR_STATUS = 500;
const RATE_LIMIT_STATUS = 429;
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

function safeMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length > MAX_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_MESSAGE_LENGTH)}...`
    : collapsed;
}

/** Extract a bounded, single-line message from an error response body. */
export function messageFromBody(body: string): string | null {
  if (body.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return safeMessage(body);
  }
  const record = asRecord(parsed);
  if (record === null) return safeMessage(parsed);
  const error = asRecord(record['error']);
  if (error !== null) {
    return (
      safeMessage(error['message']) ??
      safeMessage(error['code']) ??
      safeMessage(error['type']) ??
      null
    );
  }
  return safeMessage(record['message']);
}

/** Map an HTTP status to the normalized provider error contract. */
export function errorForStatus(status: number, providerMessage: string | null): ProviderError {
  const detail = providerMessage === null ? '' : `: ${providerMessage}`;
  if (AUTH_STATUSES.has(status)) {
    return new ProviderError('auth', `provider rejected credentials (HTTP ${status})${detail}`, {
      retryable: false,
      status,
    });
  }
  if (status === RATE_LIMIT_STATUS) {
    return new ProviderError('rate_limit', `provider rate limit (HTTP ${status})${detail}`, {
      retryable: true,
      status,
    });
  }
  if (status >= FIRST_SERVER_ERROR_STATUS) {
    return new ProviderError('server', `provider unavailable (HTTP ${status})${detail}`, {
      retryable: true,
      status,
    });
  }
  if (status >= FIRST_CLIENT_ERROR_STATUS) {
    return new ProviderError(
      'invalid_request',
      `provider rejected the request (HTTP ${status})${detail}`,
      { retryable: false, status },
    );
  }
  return new ProviderError('unknown', `unexpected provider response (HTTP ${status})${detail}`, {
    retryable: false,
    status,
  });
}

const AUTH_PATTERN = /auth|api[ _-]?key|unauthori[sz]ed|forbidden|credential/i;
const RATE_LIMIT_PATTERN = /rate[ _-]?limit|quota|too many requests|overloaded|capacity/i;

/** Map an error payload delivered inside a stream to the provider error contract. */
export function errorFromStreamPayload(payload: unknown): ProviderError {
  const record = asRecord(payload);
  const message =
    safeMessage(record?.['message']) ?? safeMessage(payload) ?? 'provider reported a stream error';
  const code = safeMessage(record?.['code']) ?? safeMessage(record?.['type']) ?? '';
  const haystack = `${message} ${code}`;
  if (AUTH_PATTERN.test(haystack)) {
    return new ProviderError('auth', message, { retryable: false });
  }
  if (RATE_LIMIT_PATTERN.test(haystack)) {
    return new ProviderError('rate_limit', message, { retryable: true });
  }
  // A stream that failed after emitting output must not be retried blindly.
  return new ProviderError('server', message, { retryable: false });
}

export interface ErrorSignals {
  readonly cancelled: AbortSignal | null;
  readonly timeout: AbortSignal | null;
}

/** Map an exception raised while dispatching or streaming to the error contract. */
export function errorFromException(error: unknown, signals: ErrorSignals): ProviderError {
  if (error instanceof ProviderError) return error;
  const name = error instanceof Error ? error.name : '';
  if (signals.cancelled?.aborted === true) {
    return new ProviderError('cancelled', 'request cancelled');
  }
  if (signals.timeout?.aborted === true || name === 'TimeoutError') {
    return new ProviderError('timeout', 'provider request timed out');
  }
  if (name === 'AbortError') return new ProviderError('cancelled', 'request aborted');
  return new ProviderError(
    'network',
    safeMessage(error instanceof Error ? error.message : null) ?? 'provider request failed',
  );
}
