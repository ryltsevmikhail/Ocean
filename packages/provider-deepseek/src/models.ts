/**
 * DeepSeek model discovery.
 *
 * One bounded `GET /models` request used only by an explicit owner connection
 * check. It performs no inference, sends no chat request and never echoes a
 * vendor body or the credential into its result.
 */

import {
  ProviderError,
  fetchHttpClient,
  type HttpClient,
  type ModelInputModality,
  type ProviderModelInfo,
} from '@runnets/provider-core';

import { DEEPSEEK_MODELS_PATH, DEEPSEEK_DEFAULT_ORIGIN, asRecord } from './wire.js';

/** Hard owner-triggered deadline; a caller cannot raise it through the port. */
export const MAX_MODEL_PROBE_MS = 10_000;
const MAX_MODELS = 200;
const MAX_MODEL_ID = 256;
const MAX_BODY = 256 * 1024;
const MODALITIES: readonly ModelInputModality[] = ['text', 'image'];

export type ModelProbeOutcome = 'ok' | 'auth' | 'network' | 'timeout' | 'server' | 'unavailable';
export type ModelProbeResult =
  | {
      readonly outcome: 'ok';
      readonly httpStatus: number;
      readonly models: readonly ProviderModelInfo[];
    }
  | {
      readonly outcome: Exclude<ModelProbeOutcome, 'ok'>;
      readonly httpStatus: number | null;
      readonly models: readonly ProviderModelInfo[];
    };

export interface ModelProbeOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly httpClient?: HttpClient;
  /** Bounded deadline; values above the owner limit are clamped. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function readModalities(value: unknown): readonly ModelInputModality[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ModelInputModality>();
  for (const item of value) {
    const match = MODALITIES.find((modality) => modality === item);
    if (match !== undefined) seen.add(match);
  }
  return MODALITIES.filter((modality) => seen.has(modality));
}
/** Parse the documented list shape; anything else is an unusable vendor answer. */
function readModels(body: string): readonly ProviderModelInfo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const data = record?.['data'];
  if (data === undefined || !Array.isArray(data) || data.length > MAX_MODELS) return null;
  const models: ProviderModelInfo[] = [];
  for (const item of data) {
    const model = asRecord(item);
    const id = model?.['id'];
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_MODEL_ID) return null;
    models.push({ id, inputModalities: readModalities(model?.['input_modalities']) });
  }
  return models;
}
function outcomeFor(status: number): Exclude<ModelProbeOutcome, 'ok'> {
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  return 'unavailable';
}
function outcomeForError(error: unknown): Exclude<ModelProbeOutcome, 'ok'> {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (error instanceof ProviderError) {
    if (error.code === 'auth') return 'auth';
    if (error.code === 'timeout') return 'timeout';
    if (error.code === 'network') return 'network';
    if (error.code === 'server') return 'server';
    return 'unavailable';
  }
  return 'network';
}
function combine(signal: AbortSignal | null, timeout: AbortSignal | null): AbortSignal | null {
  if (signal === null) return timeout;
  if (timeout === null) return signal;
  return AbortSignal.any([signal, timeout]);
}
/** Probe the vendor model list; the credential stays inside this adapter call. */
export async function probeDeepSeekModels(options: ModelProbeOptions): Promise<ModelProbeResult> {
  // An owner-triggered check that was cancelled before dispatch is incomplete, not a pass.
  if (options.signal?.aborted === true) return { outcome: 'timeout', httpStatus: null, models: [] };
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? MAX_MODEL_PROBE_MS, 1),
    MAX_MODEL_PROBE_MS,
  );
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = combine(options.signal ?? null, timeout);
  const http = options.httpClient ?? fetchHttpClient;
  const origin = (options.baseUrl ?? DEEPSEEK_DEFAULT_ORIGIN).replace(/\/+$/, '');
  try {
    const response = await http.send({
      url: `${origin}${DEEPSEEK_MODELS_PATH}`,
      method: 'GET',
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
      ...(signal === null ? {} : { signal }),
    });
    if (!response.ok)
      return { outcome: outcomeFor(response.status), httpStatus: response.status, models: [] };
    const body = await response.text();
    const models = body.length > MAX_BODY ? null : readModels(body);
    return models === null
      ? { outcome: 'server', httpStatus: response.status, models: [] }
      : { outcome: 'ok', httpStatus: response.status, models };
  } catch (error) {
    const outcome = timeout.aborted ? 'timeout' : outcomeForError(error);
    return { outcome, httpStatus: null, models: [] };
  }
}
