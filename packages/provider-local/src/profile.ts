import {
  validModelConnectionEndpoint,
  copyLocalQualification,
  type LocalModelQualification,
} from '@runnets/application';
import { ProviderError } from '@runnets/provider-core';
export type LocalAuth =
  { readonly mode: 'none' } | { readonly mode: 'api_key'; readonly key: string };
export const MODEL = 'qwen3:1.7b';
export function refuse(message: string): never {
  throw new ProviderError('invalid_request', message, { dispatch: 'not_sent', retryable: false });
}
export const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
export function localHeaders(endpoint: string, auth: LocalAuth): Record<string, string> {
  if (!validModelConnectionEndpoint('local', endpoint) || new URL(endpoint).pathname !== '/')
    refuse('invalid local endpoint');
  if (
    auth.mode !== 'none' &&
    (auth.mode !== 'api_key' ||
      !auth.key.trim() ||
      auth.key.length > 512 ||
      [...auth.key].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
  )
    refuse('invalid local auth');
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(auth.mode === 'none' ? {} : { authorization: `Bearer ${auth.key}` }),
  };
}
export function localQualification(value: unknown): LocalModelQualification {
  let q: LocalModelQualification;
  try {
    q = copyLocalQualification(value);
  } catch {
    refuse('invalid local qualification');
  }
  if (
    q.modelId !== MODEL ||
    q.configuredContextTokens !== 4096 ||
    !q.capabilities.tools ||
    !q.capabilities.streaming ||
    q.capabilities.inputModalities.length !== 1 ||
    q.capabilities.maxOutputTokens !== null ||
    q.capabilities.usage !== 'optional'
  )
    refuse('unsupported local qualification');
  return q;
}
export function assertLocalOrigin(value: Record<string, unknown>): void {
  for (const key of ['remote_model', 'remote_host'])
    if (value[key] !== undefined && value[key] !== '') refuse('remote or unknown model origin');
}
