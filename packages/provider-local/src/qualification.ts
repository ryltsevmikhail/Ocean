import type { LocalModelQualification } from '@runnets/application';
import {
  ProviderError,
  fetchHttpClient,
  withAbort,
  abortableChunks,
  readBoundedText,
  type HttpClient,
} from '@runnets/provider-core';
import { MODEL, localHeaders, object, type LocalAuth } from './profile.js';
import { qualifyMetadata } from './metadata.js';
export interface LocalModelCheckOptions {
  readonly endpoint: string;
  readonly auth: LocalAuth;
  readonly httpClient?: HttpClient;
  readonly timeoutMs?: number;
}
/** Metadata only. All requests share one bounded budget, with no weaker retry. */
export async function checkLocalModel(
  options: LocalModelCheckOptions,
  caller: AbortSignal,
): Promise<LocalModelQualification> {
  const headers = localHeaders(options.endpoint, options.auth);
  const requested = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new ProviderError('invalid_request', 'invalid local check deadline', {
      dispatch: 'not_sent',
      retryable: false,
    });
  const signal = AbortSignal.any([
    caller,
    AbortSignal.timeout(Math.min(10000, requested || 10000)),
  ]);
  const http = options.httpClient ?? fetchHttpClient;
  const values: Record<string, unknown>[] = [];
  let readingBody = false;
  try {
    for (const [path, maxBytes] of [
      ['version', 65536],
      ['tags', 1048576],
      ['show', 16777216],
    ] as const) {
      if (signal.aborted) throw signal.reason;
      readingBody = false;
      const response = await withAbort(
        http.send({
          url: `${options.endpoint}/api/${path}`,
          method: path === 'show' ? 'POST' : 'GET',
          redirect: 'manual',
          headers,
          signal,
          ...(path === 'show' ? { body: JSON.stringify({ model: MODEL, verbose: true }) } : {}),
        }),
        signal,
      );
      if (!response.ok || response.status !== 200)
        throw new ProviderError(
          response.status === 401 || response.status === 403
            ? 'auth'
            : response.status >= 500
              ? 'server'
              : 'invalid_request',
          'local metadata refused',
          { dispatch: 'not_sent', retryable: false, status: response.status },
        );
      readingBody = true;
      const body = await readBoundedText(abortableChunks(response.stream(), signal), maxBytes);
      const value = object(JSON.parse(body) as unknown);
      if (!value) throw Error('invalid metadata');
      values.push(value);
    }
    if (signal.aborted) throw signal.reason;
    return qualifyMetadata(values[0]!, values[1]!, values[2]!);
  } catch (error) {
    if (error instanceof ProviderError)
      throw new ProviderError(
        error.code,
        error.code === 'network' ? 'local metadata transport unavailable' : error.message,
        { dispatch: 'not_sent', retryable: false, status: error.status },
      );
    throw new ProviderError(
      caller.aborted
        ? 'cancelled'
        : signal.aborted
          ? 'timeout'
          : readingBody
            ? 'invalid_request'
            : 'network',
      'local metadata unavailable or invalid',
      { dispatch: 'not_sent', retryable: false },
    );
  }
}
