import {
  fetchHttpClient,
  withAbort,
  abortableChunks,
  readBoundedText,
  type HttpClient,
  type ProviderProbeResult,
} from '@runnets/provider-core';
import { ANTHROPIC_ORIGIN, ANTHROPIC_MODELS, anthropicHeaders } from './profile.js';
import { asRecord } from './wire.js';
export interface AnthropicProbeOptions {
  /** Workspace-scoped keys only; unscoped keys require a future explicit selector contract. */
  readonly apiKey: string;
  readonly httpClient?: HttpClient;
  readonly timeoutMs?: number;
}
/** One metadata retrieval proves access only, never inference or live qualification. */
export async function probeAnthropicModels(
  options: AnthropicProbeOptions,
  caller: AbortSignal,
): Promise<ProviderProbeResult> {
  if (caller.aborted) return { outcome: 'cancelled', httpStatus: null, models: [] };
  if (!options.apiKey.trim()) return { outcome: 'unavailable', httpStatus: null, models: [] };
  const requested = options.timeoutMs ?? 10000;
  const timeoutMs = Number.isSafeInteger(requested)
    ? Math.min(10000, Math.max(1, requested))
    : 10000;
  const signal = AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]);
  let status: number | null = null;
  try {
    const response = await withAbort(
      (options.httpClient ?? fetchHttpClient).send({
        url: `${ANTHROPIC_ORIGIN}/v1/models/${ANTHROPIC_MODELS[0]}`,
        method: 'GET',
        redirect: 'manual',
        headers: { ...anthropicHeaders(options.apiKey), accept: 'application/json' },
        signal,
      }),
      signal,
    );
    status = response.status;
    if (!response.ok)
      return {
        outcome:
          status === 401 || status === 403 ? 'auth' : status >= 500 ? 'server' : 'unavailable',
        httpStatus: status,
        models: [],
      };
    const body = await readBoundedText(abortableChunks(response.stream(), signal), 262144);
    if (asRecord(JSON.parse(body) as unknown)?.['id'] !== ANTHROPIC_MODELS[0])
      throw new Error('metadata shape');
    return { outcome: 'ok', httpStatus: status, models: [...ANTHROPIC_MODELS] };
  } catch {
    return {
      outcome: caller.aborted
        ? 'cancelled'
        : signal.aborted
          ? 'timeout'
          : status === null
            ? 'network'
            : 'server',
      httpStatus: status,
      models: [],
    };
  }
}
