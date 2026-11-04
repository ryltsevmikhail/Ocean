import { sameLocalQualification, type LocalModelQualification } from '@runnets/application';
import {
  ProviderError,
  assertProviderTimeout,
  fetchHttpClient,
  withAbort,
  abortableChunks,
  type HttpClient,
  type ProviderPort,
  type ProviderEvent,
} from '@runnets/provider-core';
import { MODEL, localHeaders, localQualification, type LocalAuth } from './profile.js';
import { checkLocalModel } from './qualification.js';
import { buildRequestBody } from './wire.js';
import { mapLocalStream } from './stream.js';
export interface LocalProviderOptions {
  readonly endpoint: string;
  readonly auth: LocalAuth;
  readonly qualification: LocalModelQualification;
  readonly httpClient?: HttpClient;
  readonly timeoutMs?: number;
}
export function createLocalProvider(options: LocalProviderOptions): ProviderPort {
  const headers = localHeaders(options.endpoint, options.auth),
    q = localQualification(options.qualification),
    timeout = options.timeoutMs ?? 120000,
    http = options.httpClient ?? fetchHttpClient;
  assertProviderTimeout(timeout);
  // Capture all owner evidence and auth now; later caller mutation cannot rebase this provider.
  const endpoint = options.endpoint,
    auth: LocalAuth =
      options.auth.mode === 'none' ? { mode: 'none' } : { mode: 'api_key', key: options.auth.key };
  return {
    id: 'ollama',
    models: [MODEL],
    modelInfo: [{ id: MODEL, inputModalities: ['text'] }],
    capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
    requestBytes: (r) => Buffer.byteLength(buildRequestBody(r), 'utf8'),
    async *stream(request): AsyncIterable<ProviderEvent> {
      let dispatched = false;
      const signals = [
        request.signal,
        ...(timeout > 0 ? [AbortSignal.timeout(timeout)] : []),
      ].filter((s): s is AbortSignal => s !== undefined);
      const signal = AbortSignal.any(signals);
      try {
        if (signal.aborted) throw signal.reason;
        const body = buildRequestBody(request);
        const current = await checkLocalModel({ endpoint, auth, httpClient: http }, signal);
        if (!sameLocalQualification(q, current))
          throw new ProviderError('invalid_request', 'local qualification drift', {
            dispatch: 'not_sent',
            retryable: false,
          });
        if (signal.aborted) throw signal.reason;
        dispatched = true;
        const response = await withAbort(
          http.send({
            url: `${endpoint}/api/chat`,
            method: 'POST',
            redirect: 'manual',
            headers,
            body,
            signal,
          }),
          signal,
        );
        if (!response.ok || response.status !== 200)
          throw new ProviderError(
            response.status === 401 || response.status === 403 ? 'auth' : 'server',
            'local inference refused',
            { dispatch: 'unknown', status: response.status, retryable: false },
          );
        yield* mapLocalStream(
          abortableChunks(response.stream(), signal),
          request.messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []),
          signal,
        );
      } catch (error) {
        const code = request.signal?.aborted
          ? 'cancelled'
          : signal.aborted
            ? 'timeout'
            : error instanceof ProviderError
              ? error.code
              : 'network';
        yield {
          type: 'error',
          error: new ProviderError(
            code,
            dispatched ? 'local inference failed' : 'local preflight refused',
            {
              dispatch: dispatched ? 'unknown' : 'not_sent',
              retryable: false,
              ...(error instanceof ProviderError ? { status: error.status } : {}),
            },
          ),
        };
      }
    },
  };
}
