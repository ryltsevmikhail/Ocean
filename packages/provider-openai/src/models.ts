import {
  fetchHttpClient,
  withAbort,
  abortableChunks,
  readBoundedText,
  type HttpClient,
  type ProviderProbeResult,
} from '@runnets/provider-core';
import { OPENAI_ORIGIN } from './profile.js';
import { asRecord } from './wire.js';
import { errorFromException } from './errors.js';

export interface OpenAIProbeOptions {
  readonly apiKey: string;
  readonly httpClient?: HttpClient;
  readonly timeoutMs?: number;
}
/** Metadata availability only, with one send, a hard deadline and a byte-capped reader. */
export async function probeOpenAIModels(
  options: OpenAIProbeOptions,
  caller: AbortSignal,
): Promise<ProviderProbeResult> {
  if (caller.aborted) return { outcome: 'cancelled', httpStatus: null, models: [] };
  const requested = options.timeoutMs ?? 10000;
  const timeoutMs = Number.isSafeInteger(requested)
    ? Math.min(10000, Math.max(1, requested))
    : 10000;
  const signal = AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]);
  let status: number | null = null;
  try {
    const response = await withAbort(
      (options.httpClient ?? fetchHttpClient).send({
        url: `${OPENAI_ORIGIN}/v1/models`,
        method: 'GET',
        headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
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
    const data = asRecord(JSON.parse(body) as unknown)?.['data'];
    if (!Array.isArray(data) || data.length > 200) throw new Error('metadata shape');
    const models: string[] = [];
    for (const item of data) {
      const id = asRecord(item)?.['id'];
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > 256 ||
        [...id].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        throw new Error('metadata id');
      if (!models.includes(id)) models.push(id);
    }
    return { outcome: 'ok', httpStatus: status, models };
  } catch (error) {
    const code = errorFromException(error, signal).code;
    return {
      outcome: caller.aborted
        ? 'cancelled'
        : signal.aborted
          ? 'timeout'
          : status !== null
            ? 'server'
            : code === 'auth' || code === 'timeout' || code === 'cancelled' || code === 'server'
              ? code
              : 'network',
      httpStatus: status,
      models: [],
    };
  }
}
