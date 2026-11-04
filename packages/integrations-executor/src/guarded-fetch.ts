/**
 * Guarded HTTP layer for the pinned Executor stack.
 *
 * The SDK and both plugins accept an `HttpClient` layer, so every outbound
 * request the transport makes passes through this wrapper. It is the concrete
 * enforcement point for the transport invariants the SDK does not provide:
 *
 * - fixed origin allowlist (exact scheme/host/port, no credentials in the URL),
 * - `redirect: "manual"` with every 3xx rejected (the upstream follows
 *   cross-origin redirects and would leak the request body),
 * - outbound body cap measured before the request is sent,
 * - response byte cap enforced on the streamed body,
 * - a hard per-request deadline combined with the caller's signal.
 *
 * Errors are thrown as `GuardedFetchError` with a stable code; the SDK wraps
 * them in its own transport error, and the transport adapter classifies the
 * invocation as uncertain (never retried).
 */
import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import type { HttpClient } from 'effect/unstable/http';

import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  SERVICE_PLUGIN_MAX_DISCOVERY_BYTES,
  SERVICE_PLUGIN_MAX_REQUEST_BYTES,
} from '@runnets/application';

import { normalizeOrigin } from './origins.js';

export type GuardedFetchCode =
  | 'origin_not_allowed'
  | 'credentials_in_url'
  | 'redirect_rejected'
  | 'request_too_large'
  | 'response_too_large'
  | 'unmeasurable_body';

/** Fail-closed guard violation. `code` is stable and safe to log. */
export class GuardedFetchError extends Error {
  readonly code: GuardedFetchCode;

  constructor(code: GuardedFetchCode, message: string) {
    super(message);
    this.name = 'GuardedFetchError';
    this.code = code;
  }
}

export interface GuardedHttpOptions {
  /** Exact origins (`scheme://host[:port]`) this transport may talk to. */
  readonly allowedOrigins: readonly string[];
  /** Defaults to the application cap (1 MiB). */
  readonly requestLimitBytes?: number;
  /** Defaults to the discovery cap (4 MiB). */
  readonly responseLimitBytes?: number;
  /** Defaults to the per-call deadline (30 s). */
  readonly deadlineMs?: number;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
}

export interface GuardedHttp {
  /** The guarded `fetch`; also passed to the SDK config. */
  readonly fetch: typeof fetch;
  /** Effect layer carrying the guarded `fetch` into SDK/plugin HTTP clients. */
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
}

function measureRequestBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
): number | 'unmeasurable' {
  const body = init?.body;
  if (body === null || body === undefined) {
    if (input instanceof Request) {
      if (input.body === null) return 0;
      const declared = input.headers.get('content-length');
      return declared === null ? 'unmeasurable' : Number(declared);
    }
    return 0;
  }
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString(), 'utf8');
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    let total = 0;
    for (const [, entry] of body.entries()) {
      if (typeof entry === 'string') total += Buffer.byteLength(entry, 'utf8');
      else if (typeof Blob !== 'undefined' && entry instanceof Blob) total += entry.size;
      else return 'unmeasurable';
    }
    return total;
  }
  return 'unmeasurable';
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Wrap the response body stream so the byte cap is enforced while streaming.
 * `onOverflow` aborts the request so a client waiting on a dead stream fails
 * fast instead of consuming the whole call deadline.
 */
function capResponseBody(response: Response, limit: number, onOverflow: () => void): Response {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    onOverflow();
    void response.body?.cancel();
    throw new GuardedFetchError(
      'response_too_large',
      `upstream declared ${declared} response bytes, over the ${limit}-byte cap`,
    );
  }
  if (response.body === null) return response;
  if (response.status === 204 || response.status === 205 || response.status === 304)
    return response;

  let total = 0;
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) {
          onOverflow();
          controller.error(
            new GuardedFetchError(
              'response_too_large',
              `upstream response exceeded the ${limit}-byte cap`,
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Build the guarded `fetch` and its Effect HTTP layer. Both plugin factories
 * and `createExecutor` receive the same layer, so a request cannot escape the
 * allowlist by taking a different SDK path.
 */
export function createGuardedHttp(options: GuardedHttpOptions): GuardedHttp {
  const allowed = new Set(options.allowedOrigins.map(normalizeOrigin));
  const requestLimit = options.requestLimitBytes ?? SERVICE_PLUGIN_MAX_REQUEST_BYTES;
  const responseLimit = options.responseLimitBytes ?? SERVICE_PLUGIN_MAX_DISCOVERY_BYTES;
  const deadlineMs = options.deadlineMs ?? SERVICE_PLUGIN_CALL_DEADLINE_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const guarded: typeof fetch = async (input, init) => {
    const url =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? new URL(input.href)
          : new URL(input);
    if (!allowed.has(url.origin)) {
      throw new GuardedFetchError(
        'origin_not_allowed',
        `request to ${url.origin} is outside the fixed origin allowlist`,
      );
    }
    if (url.username !== '' || url.password !== '') {
      throw new GuardedFetchError('credentials_in_url', 'request URL must not carry credentials');
    }
    const bodyBytes = measureRequestBody(input, init);
    if (bodyBytes === 'unmeasurable') {
      throw new GuardedFetchError(
        'unmeasurable_body',
        'request body kind cannot be measured before dispatch; refusing to send it',
      );
    }
    if (bodyBytes > requestLimit) {
      throw new GuardedFetchError(
        'request_too_large',
        `outbound request is ${bodyBytes} bytes, over the ${requestLimit}-byte cap`,
      );
    }

    const requestController = new AbortController();
    const deadlineSignal = AbortSignal.timeout(deadlineMs);
    const upstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = upstreamSignal
      ? AbortSignal.any([upstreamSignal, deadlineSignal, requestController.signal])
      : AbortSignal.any([deadlineSignal, requestController.signal]);
    const requestInit: RequestInit = { ...(init ?? {}), redirect: 'manual', signal };

    const response =
      input instanceof Request
        ? await fetchImpl(input, requestInit)
        : await fetchImpl(url.href, requestInit);
    if (isRedirect(response.status)) {
      await response.body?.cancel();
      throw new GuardedFetchError(
        'redirect_rejected',
        `upstream answered ${response.status}; redirects are not followed`,
      );
    }
    return capResponseBody(response, responseLimit, () => requestController.abort());
  };

  const httpClientLayer = Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, guarded),
  );
  return { fetch: guarded, httpClientLayer };
}
