import { describe, expect, it } from 'vitest';

import { ProviderError } from '@runnets/provider-core';

import {
  errorForStatus,
  errorFromException,
  errorFromStreamPayload,
  messageFromBody,
} from './errors.js';

describe('messageFromBody', () => {
  it('extracts the nested error message', async () => {
    expect(messageFromBody('{"error":{"message":"bad key"}}')).toBe('bad key');
  });

  it('falls back to the error code and type', async () => {
    expect(messageFromBody('{"error":{"code":"invalid_api_key"}}')).toBe('invalid_api_key');
    expect(messageFromBody('{"error":{"type":"rate_limit"}}')).toBe('rate_limit');
  });

  it('keeps a plain non-JSON body as the message', () => {
    expect(messageFromBody('service unavailable')).toBe('service unavailable');
  });

  it('returns null for an empty body', () => {
    expect(messageFromBody('  \n ')).toBeNull();
  });

  it('collapses whitespace and bounds the message length', () => {
    expect(messageFromBody('{"error":{"message":"line1\\nline2"}}')).toBe('line1 line2');
    const long = messageFromBody(JSON.stringify({ error: { message: 'x'.repeat(500) } }));
    expect(long).toHaveLength(303);
    expect(long?.endsWith('...')).toBe(true);
  });
});

describe('errorForStatus', () => {
  const cases: ReadonlyArray<[number, string, boolean]> = [
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limit', true],
    [400, 'invalid_request', false],
    [404, 'invalid_request', false],
    [500, 'server', true],
    [502, 'server', true],
    [302, 'unknown', false],
  ];

  it.each(cases)('maps HTTP %i to %s (retryable=%s)', (status, code, retryable) => {
    const error = errorForStatus(status, 'upstream detail');
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(status);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain('upstream detail');
  });

  it('omits the detail suffix when no provider message is available', () => {
    expect(errorForStatus(429, null).message).toBe('provider rate limit (HTTP 429)');
  });
});

describe('errorFromStreamPayload', () => {
  it('classifies authentication failures by message and type', () => {
    const error = errorFromStreamPayload({ message: 'Authentication Fails', type: 'auth_error' });
    expect(error.code).toBe('auth');
    expect(error.retryable).toBe(false);
  });

  it('classifies quota and rate limit failures as retryable', () => {
    expect(errorFromStreamPayload({ message: 'Rate limit exceeded' }).code).toBe('rate_limit');
    expect(errorFromStreamPayload('quota exhausted').code).toBe('rate_limit');
  });

  it('fails safe for an unclassified mid-stream error', () => {
    const error = errorFromStreamPayload({ message: 'internal explosion' });
    expect(error.code).toBe('server');
    expect(error.retryable).toBe(false);
  });

  it('uses a generic message when the payload carries none', () => {
    expect(errorFromStreamPayload({}).message).toBe('provider reported a stream error');
  });
});

describe('errorFromException', () => {
  const idle = { cancelled: null, timeout: null };

  it('passes an existing provider error through unchanged', () => {
    const original = new ProviderError('server', 'boom');
    expect(errorFromException(original, idle)).toBe(original);
  });

  it('maps an abort exception to cancellation', () => {
    const aborted = AbortSignal.abort();
    const error = errorFromException(new DOMException('aborted', 'AbortError'), {
      cancelled: aborted,
      timeout: null,
    });
    expect(error).toMatchObject({ code: 'cancelled', retryable: false });
  });

  it('maps a timeout exception to a retryable timeout', () => {
    const timedOut = AbortSignal.abort();
    const error = errorFromException(new DOMException('timed out', 'TimeoutError'), {
      cancelled: null,
      timeout: timedOut,
    });
    expect(error).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('prefers cancellation when both signals are aborted', () => {
    const aborted = AbortSignal.abort();
    const error = errorFromException(new Error('aborted'), {
      cancelled: aborted,
      timeout: aborted,
    });
    expect(error.code).toBe('cancelled');
  });

  it('maps unknown exceptions to a retryable network error', () => {
    const error = errorFromException(new TypeError('connection reset'), idle);
    expect(error).toMatchObject({ code: 'network', retryable: true, message: 'connection reset' });
  });

  it('uses a generic message for a non-error rejection', () => {
    expect(errorFromException('weird', idle).message).toBe('provider request failed');
  });
});
