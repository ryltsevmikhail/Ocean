import { expect, it } from 'vitest';
import { validModelConnectionEndpoint } from '@runnets/application';
import { validateModelSet } from './model-connection-input.js';
import type { ModelConnectionSetInput } from './model-connection-types.js';

function input(kind: 'cloud' | 'local', endpoint: string): ModelConnectionSetInput {
  return {
    connectionId: 'connection',
    requestId: 'request',
    expectedRevision: null,
    providerId: 'fixture',
    defaultModelId: 'model',
    endpoint,
    kind,
    auth: kind === 'cloud' ? 'api_key' : 'none',
    ...(kind === 'cloud' ? { key: 'fixture-key' } : {}),
  };
}
it.each([
  ['cloud', 'https://configured.invalid'],
  ['cloud', 'https://configured.invalid/v1'],
  ['cloud', 'https://configured.invalid/v1/'],
  ['cloud', 'https://configured.invalid/v1%2Fpath'],
  ['local', 'http://127.0.0.1:8080'],
  ['local', 'http://127.0.0.2:8080/v1'],
  ['local', 'https://[::1]:8080/v1'],
] as const)('preserves unchanged owner endpoint eligibility for %s %s', (kind, endpoint) => {
  expect(validModelConnectionEndpoint(kind, endpoint)).toBe(true);
  expect(() => validateModelSet(input(kind, endpoint))).not.toThrow();
});
it.each([
  ['cloud', 'http://configured.invalid'],
  ['cloud', 'https://user@configured.invalid/v1'],
  ['cloud', 'https://configured.invalid/v1?'],
  ['cloud', 'https://configured.invalid/v1#'],
  ['cloud', 'https://configured.invalid/'],
  ['cloud', 'https://CONFIGURED.invalid'],
  ['cloud', 'https://configured.invalid:443'],
  ['cloud', 'https://configured.invalid/v1/../api'],
  ['cloud', 'https://configured.invalid/' + 'a'.repeat(2048)],
  ['cloud', 'https://configured.invalid/\0'],
  ['local', 'http://localhost:8080'],
  ['local', 'https://configured.invalid'],
  ['local', 'http://127.1:8080'],
] as const)('retains invalid_params for owner endpoint %s %s', (kind, endpoint) => {
  expect(validModelConnectionEndpoint(kind, endpoint)).toBe(false);
  expect(() => validateModelSet(input(kind, endpoint))).toThrow('invalid_params');
});
it.each([null, undefined, '', ' ', 1])(
  'refuses malformed persisted endpoint values without throwing (%s)',
  (value) => {
    expect(validModelConnectionEndpoint('cloud', value)).toBe(false);
  },
);
