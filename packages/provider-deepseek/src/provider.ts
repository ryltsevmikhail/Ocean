/**
 * DeepSeek provider adapter.
 *
 * Implements the provider-neutral port over the DeepSeek streaming chat
 * completions API. The API key lives only inside the adapter: it is never
 * logged and never appears in an error message.
 */

import {
  ProviderError,
  assertProviderTimeout,
  withAbort,
  abortableChunks,
  readBoundedText,
  REQUEST_HARD_LIMIT_BYTES,
  fetchHttpClient,
  type HttpClient,
  type HttpResponse,
  type ModelRequest,
  type ProviderEvent,
  type ProviderModelInfo,
  type ProviderPort,
} from '@runnets/provider-core';

import { errorForStatus, errorFromException, messageFromBody } from './errors.js';
import { mapStream } from './stream.js';
import {
  DEEPSEEK_CHAT_PATH,
  DEEPSEEK_DEFAULT_ORIGIN,
  WireContentError,
  buildRequestBody,
  serializedBodyBytes,
} from './wire.js';

/**
 * Models advertised when the host does not configure its own list.
 *
 * The vendor documents exactly these two chat-completions ids; the discontinued
 * `deepseek-chat`/`deepseek-reasoner` ids are never advertised again.
 */
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;

/** Documented per-model input modalities (vendor `GET /models` metadata). */
export const DEEPSEEK_MODEL_INFO: readonly ProviderModelInfo[] = [
  { id: 'deepseek-flash', inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4-pro', inputModalities: ['text'] },
];

const DEFAULT_TIMEOUT_MS = 120_000;

export interface DeepSeekProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly httpClient?: HttpClient;
  /** Request deadline; 0 disables it. An aborted `request.signal` wins. */
  readonly timeoutMs?: number;
}

function combineSignals(
  cancelled: AbortSignal | null,
  timeout: AbortSignal | null,
): AbortSignal | null {
  if (cancelled === null) return timeout;
  if (timeout === null) return cancelled;
  return AbortSignal.any([cancelled, timeout]);
}

export class DeepSeekProvider implements ProviderPort {
  readonly id = 'deepseek';
  readonly models: readonly string[];
  readonly capabilities = {
    streaming: true,
    reasoning: true,
    usage: true,
    toolCalls: true,
  } as const;
  /** Documented per-model input modalities; admission refuses unsupported images. */
  readonly modelInfo: readonly ProviderModelInfo[] = DEEPSEEK_MODEL_INFO;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #http: HttpClient;
  readonly #timeoutMs: number;

  constructor(options: DeepSeekProviderOptions) {
    if (options.apiKey.trim() === '') {
      throw new ProviderError('auth', 'DeepSeek API key is empty', { retryable: false });
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEEPSEEK_DEFAULT_ORIGIN).replace(/\/+$/, '');
    this.models = options.models ?? DEEPSEEK_MODELS;
    this.#http = options.httpClient ?? fetchHttpClient;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    assertProviderTimeout(this.#timeoutMs);
  }

  stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    return this.#stream(request);
  }

  /** The adapter's one serializer, shared with the application pre-check. */
  requestBytes(request: ModelRequest): number {
    return serializedBodyBytes(request);
  }

  async *#stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
    const cancelled = request.signal ?? null;
    if (cancelled?.aborted === true) {
      yield { type: 'error', error: new ProviderError('cancelled', 'request cancelled') };
      return;
    }

    const timeout = this.#timeoutMs > 0 ? AbortSignal.timeout(this.#timeoutMs) : null;
    const signal = combineSignals(cancelled, timeout);

    let body: string;
    try {
      body = buildRequestBody(request);
    } catch (error) {
      if (error instanceof WireContentError) {
        yield { type: 'error', error: new ProviderError('invalid_request', error.message) };
        return;
      }
      throw error;
    }
    // Hard gate: the complete serialized UTF-8 body must fit the vendor limit.
    // A typed refusal here happens before any network call.
    if (Buffer.byteLength(body, 'utf8') > REQUEST_HARD_LIMIT_BYTES) {
      yield { type: 'error', error: new ProviderError('invalid_request', 'request_too_large') };
      return;
    }

    let response: HttpResponse;
    try {
      response = await withAbort(
        this.#http.send({
          url: `${this.#baseUrl}${DEEPSEEK_CHAT_PATH}`,
          redirect: 'manual',
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body,
          ...(signal === null ? {} : { signal }),
        }),
        signal ?? undefined,
      );
    } catch (error) {
      yield { type: 'error', error: errorFromException(error, { cancelled, timeout }) };
      return;
    }

    if (!response.ok) {
      const body =
        response.status >= 300 && response.status < 400
          ? ''
          : await readBoundedText(
              abortableChunks(response.stream(), signal ?? undefined),
              262144,
            ).catch(() => '');
      yield { type: 'error', error: errorForStatus(response.status, messageFromBody(body)) };
      return;
    }

    try {
      yield* mapStream(abortableChunks(response.stream(), signal ?? undefined), request.model);
    } catch (error) {
      yield { type: 'error', error: errorFromException(error, { cancelled, timeout }) };
    }
  }
}

/** Construct the adapter; the host owns key resolution and model selection. */
export function createDeepSeekProvider(options: DeepSeekProviderOptions): DeepSeekProvider {
  return new DeepSeekProvider(options);
}
