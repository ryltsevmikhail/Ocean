import {
  ProviderError,
  abortableChunks,
  readBoundedText,
  type HttpResponse,
} from '@runnets/provider-core';
import { asRecord } from './wire.js';
export function malformedStream(): ProviderError {
  return new ProviderError('server', 'malformed or unsupported Anthropic stream', {
    retryable: false,
  });
}
export function errorFromException(error: unknown, signal?: AbortSignal): ProviderError {
  const reason: unknown = signal?.aborted === true ? signal.reason : error;
  const name = reason instanceof Error ? reason.name : '';
  if (signal?.aborted === true)
    return new ProviderError(
      name === 'TimeoutError' ? 'timeout' : 'cancelled',
      'Anthropic transport interrupted',
    );
  if (error instanceof ProviderError)
    return new ProviderError(error.code, 'Anthropic request failed', {
      retryable: error.retryable,
      status: error.status,
    });
  return new ProviderError(
    name === 'TimeoutError' ? 'timeout' : name === 'AbortError' ? 'cancelled' : 'network',
    'Anthropic transport interrupted',
  );
}
/** Only structured documented validation/auth evidence proves rejection. Never infer from text. */
export async function errorForResponse(
  response: HttpResponse,
  signal?: AbortSignal,
): Promise<ProviderError> {
  const status = response.status;
  const code =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limit'
        : status >= 500
          ? 'server'
          : 'invalid_request';
  let rejected = false;
  if (status === 400 || status === 401 || status === 403) {
    try {
      const body = await readBoundedText(abortableChunks(response.stream(), signal), 65536);
      const record = asRecord(JSON.parse(body) as unknown);
      const detail = asRecord(record?.['error']);
      const type = detail?.['type'];
      rejected =
        record?.['type'] === 'error' &&
        Object.keys(record).every((key) => ['type', 'error', 'request_id'].includes(key)) &&
        (record['request_id'] === undefined || typeof record['request_id'] === 'string') &&
        detail !== null &&
        Object.keys(detail).every((key) => key === 'type' || key === 'message') &&
        typeof detail['message'] === 'string' &&
        ((status === 400 && type === 'invalid_request_error') ||
          (status === 401 && type === 'authentication_error') ||
          (status === 403 && type === 'permission_error'));
    } catch {
      if (signal?.aborted === true) throw signal.reason;
      /* Missing response evidence retains unknown execution. */
    }
  }
  return new ProviderError(code, `Anthropic request failed (HTTP ${status})`, {
    status,
    dispatch: rejected ? 'rejected' : 'unknown',
    ...(rejected ? { retryable: false } : {}),
  });
}
