import {
  ProviderError,
  REQUEST_HARD_LIMIT_BYTES,
  fetchHttpClient,
  abortableChunks,
  withAbort,
  type HttpClient,
  type ProviderPort,
  type ProviderEvent,
  type ModelRequest,
} from '@runnets/provider-core';
import {
  ANTHROPIC_ORIGIN,
  ANTHROPIC_MODELS,
  ANTHROPIC_MODEL_INFO,
  anthropicHeaders,
} from './profile.js';
import { buildRequestBody, serializedBodyBytes } from './wire.js';
import { errorForResponse, errorFromException } from './errors.js';
import { mapStream } from './stream.js';
export interface AnthropicProviderOptions {
  /** Initial profile requires a workspace-scoped key; no workspace is inferred or discovered. */
  readonly apiKey: string;
  readonly httpClient?: HttpClient;
  /** Zero disables inference deadline, preserving caller cancellation. */
  readonly timeoutMs?: number;
}
export function createAnthropicProvider(options: AnthropicProviderOptions): ProviderPort {
  if (!options.apiKey.trim())
    throw new ProviderError('auth', 'Anthropic API key is empty', {
      dispatch: 'not_sent',
      retryable: false,
    });
  const http = options.httpClient ?? fetchHttpClient,
    timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
    throw new ProviderError('invalid_request', 'invalid Anthropic deadline', {
      dispatch: 'not_sent',
      retryable: false,
    });
  return {
    id: 'anthropic',
    models: ANTHROPIC_MODELS,
    modelInfo: ANTHROPIC_MODEL_INFO,
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    requestBytes: serializedBodyBytes,
    async *stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
      if (request.signal?.aborted === true) {
        yield {
          type: 'error',
          error: new ProviderError('cancelled', 'request cancelled', { dispatch: 'not_sent' }),
        };
        return;
      }
      let body: string;
      try {
        body = buildRequestBody(request);
        if (Buffer.byteLength(body, 'utf8') > REQUEST_HARD_LIMIT_BYTES)
          throw new ProviderError('invalid_request', 'request_too_large', {
            dispatch: 'not_sent',
            retryable: false,
          });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        yield { type: 'error', error };
        return;
      }
      const signals = [
        request.signal,
        timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      ].filter((s): s is AbortSignal => s !== undefined);
      const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
      try {
        const response = await withAbort(
          http.send({
            url: `${ANTHROPIC_ORIGIN}/v1/messages`,
            method: 'POST',
            redirect: 'manual',
            headers: {
              ...anthropicHeaders(options.apiKey),
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body,
            ...(signal === undefined ? {} : { signal }),
          }),
          signal,
        );
        if (!response.ok) {
          yield { type: 'error', error: await errorForResponse(response, signal) };
          return;
        }
        yield* mapStream(abortableChunks(response.stream(), signal), signal);
      } catch (error) {
        yield { type: 'error', error: errorFromException(error, signal) };
      }
    },
  };
}
