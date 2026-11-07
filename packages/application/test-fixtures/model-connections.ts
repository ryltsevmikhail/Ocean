/* eslint-disable no-restricted-imports -- Same-package deterministic model factory fixture. */
import type { ModelConnectionService } from '../src/model-connections.js';
import type { ModelConnectionServiceOptions } from '../src/model-connection-state.js';
import type { ModelCatalogEntry, ModelConnectionSetInput } from '../src/model-connection-types.js';
import { fakeCredentials, fakeSecrets } from './provider-connection-fakes.js';
import { memoryModelStore } from './model-connection-store.js';
import { sha256 } from './provider-connection-service.js';
export const localSet = (connectionId: string): ModelConnectionSetInput => ({
  connectionId,
  requestId: `set-${connectionId}`,
  expectedRevision: null,
  providerId: 'fixture',
  kind: 'local',
  endpoint: 'http://127.0.0.1:8080',
  auth: 'none',
  defaultModelId: 'fixture-model',
});
export function modelFixture(
  Service: typeof ModelConnectionService,
  gates: Partial<ModelConnectionServiceOptions> = {},
) {
  const memory = memoryModelStore();
  const secrets = fakeSecrets();
  const secretCalls: string[] = [];
  for (const method of ['read', 'write', 'replace', 'remove'] as const) {
    const original = secrets[method].bind(secrets) as (...args: string[]) => never;
    Object.assign(secrets, {
      [method]: (...args: string[]) => {
        secretCalls.push(method);
        return original(...args);
      },
    });
  }
  const externalCalls: string[] = [];
  const credentials = fakeCredentials();
  const catalog: ModelCatalogEntry[] = [
    {
      modelId: 'fixture-model',
      capabilities: {
        tools: false,
        streaming: true,
        inputModalities: ['text'],
        contextTokens: null,
        maxOutputTokens: null,
        usage: 'unavailable',
      },
    },
  ];
  let ids = 0;
  const factory: ModelConnectionServiceOptions['factory'] = {
    catalog: () => catalog,
    activate: (descriptor, secret) =>
      descriptor.auth === 'none'
        ? {
            source: 'auth_none',
            provider: {
              id: 'fixture',
              models: ['fixture-model'],
              capabilities: { streaming: true, reasoning: false, usage: false },
              async *stream() {
                yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
              },
            },
            check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['fixture-model'] }),
          }
        : secret?.status === 'ok'
          ? credentials.own(secret.key)
          : null,
    external: (descriptor) => {
      externalCalls.push(descriptor.connectionId);
      return null;
    },
  };
  const options: ModelConnectionServiceOptions = {
    store: memory.store,
    secrets,
    factory,
    clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
    nextId: () => String(++ids),
    sha256,
    ...gates,
  };
  return {
    ...memory,
    secrets,
    secretCalls,
    externalCalls,
    catalog,
    factory,
    options,
    service: new Service(options),
  };
}
