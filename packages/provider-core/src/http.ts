/**
 * Minimal HTTP seam.
 *
 * Adapters depend on this interface, not on `fetch`, so streaming behaviour is
 * testable without a network and a host can swap the client out.
 */

import { ProviderError } from './provider.js';

export interface HttpRequest {
  readonly url: string;
  /** HTTP method; existing chat-completion callers keep the historical POST default. */
  readonly method?: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** Request body; absent for a bounded metadata GET. */
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Full body, for error responses. */
  text(): Promise<string>;
  /** Incremental decoded text, for streamed success responses. */
  stream(): AsyncIterable<string>;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/** A `fetch`-compatible function; injectable so the transport is testable offline. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function* decode(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (body === null) return;
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    const text = decoder.decode(chunk, { stream: true });
    if (text !== '') yield text;
  }
  const tail = decoder.decode();
  if (tail !== '') yield tail;
}

/** Normalize a transport failure to the adapter error contract. */
function transportError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') return new ProviderError('timeout', 'provider request timed out');
  if (name === 'AbortError') return new ProviderError('cancelled', 'request aborted');
  return new ProviderError(
    'network',
    error instanceof Error ? error.message : 'network request failed',
  );
}

/**
 * Build an `HttpClient` over a `fetch`-compatible function.
 *
 * Only transport concerns live here: interpreting a status code belongs to the
 * adapter, and the request body (which may echo user content) is never logged.
 */
export function createFetchHttpClient(fetchImpl: FetchLike = globalThis.fetch): HttpClient {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      let response: Response;
      try {
        const init: RequestInit = {
          method: request.method ?? 'POST',
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        response = await fetchImpl(request.url, init);
      } catch (error) {
        throw transportError(error);
      }
      return {
        status: response.status,
        ok: response.ok,
        text: () => response.text(),
        stream: () => decode(response.body),
      };
    },
  };
}

/** `fetch`-backed client; the only place that touches the network. */
export const fetchHttpClient: HttpClient = createFetchHttpClient();
