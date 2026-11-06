import {
  ProviderError,
  assertProviderTimeout,
  REQUEST_HARD_LIMIT_BYTES,
  fetchHttpClient,
  abortableChunks,
  withAbort,
  type HttpClient,
  type ModelRequest,
  type ProviderEvent,
  type ProviderPort,
} from '@runnets/provider-core';
import { OPENAI_ORIGIN, OPENAI_MODELS, OPENAI_MODEL_INFO } from './profile.js';
import { buildRequestBody, serializedBodyBytes } from './wire.js';
import { errorForStatus, errorFromException } from './errors.js';
import { mapStream } from './stream.js';

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly httpClient?: HttpClient;
  /** Zero disables the inference deadline; caller cancellation remains active. */
  readonly timeoutMs?: number;
}
export function createOpenAIProvider(options: OpenAIProviderOptions): ProviderPort {
  const apiKey = options.apiKey;
  if (apiKey.trim() === '')
    throw new ProviderError('auth', 'OpenAI API key is empty', {
      dispatch: 'not_sent',
      retryable: false,
    });
  const http = options.httpClient ?? fetchHttpClient;
  const timeoutMs = options.timeoutMs ?? 120000;
  assertProviderTimeout(timeoutMs);
  return {
    id: 'openai',
    models: OPENAI_MODELS,
    modelInfo: OPENAI_MODEL_INFO,
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
            retryable: false,
            dispatch: 'not_sent',
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
      let authorized = false;
      try {
        authorized = request.authorizeDispatch?.() !== false;
      } catch {
        /* A veto proves no send. */
      }
      if (!authorized || signal?.aborted) {
        yield {
          type: 'error',
          error: new ProviderError('invalid_request', 'model dispatch refused', {
            dispatch: 'not_sent',
            retryable: false,
          }),
        };
        return;
      }
      try {
        const response = await withAbort(
          http.send({
            url: `${OPENAI_ORIGIN}/v1/chat/completions`,
            redirect: 'manual',
            method: 'POST',
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body,
            ...(signal === undefined ? {} : { signal }),
          }),
          signal,
        );
        if (!response.ok) {
          yield { type: 'error', error: errorForStatus(response.status) };
          return;
        }
        yield* mapStream(abortableChunks(response.stream(), signal), signal);
      } catch (error) {
        yield { type: 'error', error: errorFromException(error, signal) };
      }
    },
  };
}
