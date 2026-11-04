/* eslint-disable no-restricted-imports -- Test-only fixture for the same application package's ports. */
import { createHash } from 'node:crypto';
import {
  ProviderConnectionService,
  type ProviderConnectionServiceOptions,
} from '../src/provider-connections.js';
import type { ProviderConnectionRecord } from '../src/provider-connection-ports.js';
import {
  environmentCredential,
  fakeCredentials,
  fakeSecrets,
  fakeStore,
} from './provider-connection-fakes.js';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const set = { requestId: 'set-1', key: 'sk-fixture-saved-key', model: 'deepseek-flash' };
export const disconnect = { requestId: 'disconnect-1', expectedRevision: 1 };
export const remove = { requestId: 'remove-1', expectedRevision: 2 };
export function fixture(
  options: {
    restored?: boolean;
    mutationsAllowed?: boolean;
    injected?: ProviderConnectionServiceOptions['injected'];
    environment?: boolean;
  } = {},
) {
  const store = fakeStore();
  const secrets = fakeSecrets();
  const credentials = fakeCredentials();
  if (options.environment === true) credentials.setEnvironment(environmentCredential());
  const state = { now: Date.parse('2026-11-04T00:00:00.000Z'), ids: 0 };
  const build = () =>
    new ProviderConnectionService({
      store,
      secrets,
      credentials,
      clock: { now: () => new Date(state.now) },
      nextId: () => (++state.ids).toString(16).padStart(32, '0'),
      sha256,
      mutationsAllowed: options.mutationsAllowed ?? true,
      ...(options.restored === true ? { restored: true } : {}),
      ...(options.injected === undefined ? {} : { injected: options.injected }),
    });
  let service = build();
  service.initialize();
  return {
    store,
    secrets,
    credentials,
    get service() {
      return service;
    },
    restart() {
      service = build();
      service.initialize();
      return service;
    },
    advance(ms: number) {
      state.now += ms;
    },
    seed(row: ProviderConnectionRecord, key?: string) {
      store.rows.set(row.provider, row);
      if (row.secretRef !== null && key !== undefined) secrets.values.set(row.secretRef, key);
    },
  };
}
