import { ProviderError } from '@runnets/provider-core';

/** Fixed messages deliberately omit arbitrary vendor/transport payloads. */
export function errorForStatus(status: number): ProviderError {
  const code =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limit'
        : status >= 500
          ? 'server'
          : 'invalid_request';
  return new ProviderError(code, `OpenAI request failed (HTTP ${status})`, { status });
}
export function errorFromException(error: unknown, signal?: AbortSignal): ProviderError {
  const reason: unknown = signal?.aborted === true ? signal.reason : error;
  const name = reason instanceof Error ? reason.name : '';
  if (signal?.aborted === true)
    return new ProviderError(
      name === 'TimeoutError' ? 'timeout' : 'cancelled',
      'OpenAI transport interrupted',
    );
  if (error instanceof ProviderError)
    return new ProviderError(error.code, 'OpenAI request failed', {
      retryable: error.retryable,
      status: error.status,
    });
  return new ProviderError(
    name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'cancelled' : 'network',
    'OpenAI transport interrupted',
  );
}
export function malformedStream(): ProviderError {
  return new ProviderError('server', 'malformed or incomplete OpenAI stream', { retryable: false });
}
