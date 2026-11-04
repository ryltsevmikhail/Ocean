import { describe, expect, it } from 'vitest';
import type { ProviderConnectionRecord } from './provider-connection-ports.js';
import { resolveProviderConnection } from './provider-connection-resolution.js';
import {
  environmentCredential,
  fakeCredentials,
  record,
} from '../test-fixtures/provider-connection-fakes.js';

const key = { status: 'ok', key: 'saved-key' } as const;
function resolve(
  row: ProviderConnectionRecord | null,
  secret: Parameters<typeof resolveProviderConnection>[0]['secret'],
  options: { restored?: boolean; environment?: boolean } = {},
) {
  const credentials = fakeCredentials();
  credentials.setEnvironment(options.environment === true ? environmentCredential() : null);
  return resolveProviderConnection({
    record: row,
    secret,
    environment: credentials.environment(),
    credentials,
    restored: options.restored === true,
  });
}

describe('provider connection truth table', () => {
  it('activates a readable saved connection with its selected model', () => {
    const result = resolve(record({ secretRef: 'psec_a' }), key);
    expect(result).toMatchObject({
      source: 'saved',
      state: 'connected',
      code: null,
      model: 'deepseek-flash',
      savedKey: true,
    });
    expect(result.credential?.provider.id).toBe('deepseek');
  });
  it('uses the environment as an explicitly external, read-only source', () => {
    const result = resolve(record({ secretRef: null }), null, { environment: true });
    expect(result).toMatchObject({ source: 'external', state: 'connected', savedKey: false });
    expect(result.credential?.source).toBe('external');
  });
  it('is absent with neither a saved value nor an environment value', () => {
    expect(resolve(record({ secretRef: null }), null)).toMatchObject({
      source: 'none',
      state: 'absent',
      credential: null,
      savedKey: false,
    });
  });
  it('fails closed on a missing saved secret and never falls back to the environment', () => {
    const result = resolve(
      record({ secretRef: 'psec_gone' }),
      { status: 'absent' },
      {
        environment: true,
      },
    );
    expect(result).toMatchObject({
      source: 'none',
      state: 'unverified',
      code: 'provider_unverified',
      credential: null,
      savedKey: true,
    });
  });
  it('fails closed on a corrupt private store with its explicit reason', () => {
    expect(
      resolve(
        record({ secretRef: 'psec_a' }),
        {
          status: 'unverified',
          reason: 'provider_secret_corrupt',
        },
        { environment: true },
      ),
    ).toMatchObject({ state: 'unverified', code: 'provider_secret_corrupt', credential: null });
  });
  it('fails closed on a pending intent even when a secret would be readable', () => {
    const result = resolve(record({ secretRef: 'psec_a', intent: 'pending' }), key, {
      environment: true,
    });
    expect(result).toMatchObject({
      source: 'none',
      state: 'unverified',
      code: 'provider_unverified',
      credential: null,
    });
  });
  it('keeps an explicit disconnect above a retained secret and the environment', () => {
    const result = resolve(record({ secretRef: 'psec_a', intent: 'disconnected' }), key, {
      environment: true,
    });
    expect(result).toMatchObject({
      source: 'none',
      state: 'disconnected',
      code: 'provider_disconnected',
      credential: null,
      savedKey: true,
    });
  });
  it('stays inert on a restored profile even with a readable saved value and environment', () => {
    const result = resolve(record({ secretRef: 'psec_a' }), key, {
      restored: true,
      environment: true,
    });
    expect(result).toMatchObject({
      source: 'none',
      state: 'restored',
      code: 'provider_restored',
      credential: null,
      model: null,
    });
  });
  it('fails closed instead of silently switching an unknown persisted model', () => {
    expect(resolve(record({ secretRef: 'psec_a', model: 'deepseek-chat' }), key)).toMatchObject({
      state: 'invalid_model',
      code: 'provider_invalid_model',
      model: 'deepseek-chat',
      credential: null,
    });
    expect(
      resolve(record({ secretRef: null, model: 'deepseek-chat' }), null, { environment: true }),
    ).toMatchObject({ state: 'invalid_model', source: 'external', credential: null });
  });
  it('defaults a null selection to the adapter default without inventing a model', () => {
    expect(resolve(record({ model: null }), null, { environment: true })).toMatchObject({
      model: 'deepseek-flash',
      state: 'connected',
    });
  });
  it('never reports an absent model from a null row with no advertised models', () => {
    const credentials = fakeCredentials([]);
    const result = resolveProviderConnection({
      record: null,
      secret: null,
      environment: null,
      credentials,
      restored: false,
    });
    expect(result).toMatchObject({ state: 'absent', model: null, credential: null, revision: 0 });
  });
});
