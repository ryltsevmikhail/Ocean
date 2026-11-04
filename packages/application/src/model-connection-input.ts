import type { ModelConnectionSetInput } from './model-connection-types.js';
import { validKey, validRevision } from './provider-connection-request.js';
const bytes = (value: string) => new TextEncoder().encode(value).length;
export function boundedModelText(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.includes('\0') ||
    bytes(value) > max
  )
    throw Error('invalid_params');
  return value;
}
export function modelRevision(value: number | null): number | null {
  return value === null ? null : validRevision(value);
}
export function validateModelSet(input: ModelConnectionSetInput): void {
  boundedModelText(input.providerId, 64);
  boundedModelText(input.defaultModelId, 256);
  boundedModelText(input.endpoint, 2048);
  if (
    (input.kind !== 'cloud' && input.kind !== 'local') ||
    (input.auth !== 'api_key' && input.auth !== 'none')
  )
    throw Error('invalid_params');
  if (input.key !== undefined) validKey(input.key);
  if (input.auth === 'none' && (input.kind !== 'local' || input.key !== undefined))
    throw Error('invalid_params');
  if (!validModelConnectionEndpoint(input.kind, input.endpoint)) throw Error('invalid_params');
}

/** Eligibility for unchanged owner or persisted endpoint metadata; no normalization or I/O. */
export function validModelConnectionEndpoint(
  kind: 'cloud' | 'local',
  value: unknown,
): value is string {
  try {
    const text = boundedModelText(value, 2048);
    const endpoint = new URL(text);
    if (
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.search !== '' ||
      endpoint.hash !== '' ||
      /[?#]/.test(text)
    )
      return false;
    if (endpoint.origin + (endpoint.pathname === '/' ? '' : endpoint.pathname) !== text)
      return false;
    if (kind === 'cloud') return endpoint.protocol === 'https:';
    if (kind !== 'local') return false;
    return (
      ['http:', 'https:'].includes(endpoint.protocol) &&
      (endpoint.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(endpoint.hostname))
    );
  } catch {
    return false;
  }
}
