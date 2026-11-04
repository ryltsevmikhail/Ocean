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
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw Error('invalid_params');
  }
  if (
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    /[?#]/.test(input.endpoint)
  )
    throw Error('invalid_params');
  if (input.kind === 'cloud') {
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.origin + (endpoint.pathname === '/' ? '' : endpoint.pathname) !== input.endpoint
    )
      throw Error('invalid_params');
  } else {
    const host = endpoint.hostname;
    if (endpoint.origin + (endpoint.pathname === '/' ? '' : endpoint.pathname) !== input.endpoint)
      throw Error('invalid_params');
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      !(host === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host))
    )
      throw Error('invalid_params');
  }
}
