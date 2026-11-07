import { expect, it } from 'vitest';
import { ProviderActivationService } from './provider-activation.js';
import { activationFixture } from '../test-fixtures/provider-activation.js';
import { fakeSecrets } from '../test-fixtures/provider-connection-fakes.js';
import type { ModelCredentialFactory } from './model-credential-ports.js';
import { unconfiguredModelConnection } from './model-connection-ports.js';
import type { ModelConnectionRecord } from './model-connection-ports.js';

function fixture() {
  const f = activationFixture();
  const secrets = fakeSecrets();
  secrets.values.set('saved-ref', 'private-key');
  const record: ModelConnectionRecord = {
    ...f.store.read('legacy:scripted')!,
    endpoint: 'https://fixture.invalid',
    defaultModelId: 'retired-default',
    intent: 'active',
    revision: 1,
    secretRef: 'saved-ref',
  };
  f.store.put(record, 0);
  const descriptors: unknown[] = [];
  let reads = 0;
  secrets.readOverride = () => {
    reads++;
    return null;
  };
  let models = ['scripted'];
  const factory: ModelCredentialFactory = {
    catalog: (d) => {
      descriptors.push(d);
      return models.map((modelId) => ({ modelId, capabilities: f.snapshot.capabilities }));
    },
    activate: (d) => {
      descriptors.push(d);
      return {
        source: 'saved',
        provider: f.provider,
        check: async () => ({ outcome: 'ok', httpStatus: 200, models }),
      };
    },
    external: () => ({
      source: 'external',
      provider: f.provider,
      check: async () => ({ outcome: 'ok', httpStatus: 200, models }),
    }),
  };
  const deps = {
    connections: f.store.modelConnections,
    factory,
    secrets,
    restored: false,
    disabled: false,
  };
  const bound = { bot: f.bot, binding: { connectionId: record.connectionId, modelId: 'scripted' } };
  return {
    ...f,
    deps,
    bound,
    record,
    descriptors,
    reads: () => reads,
    models: (value: string[]) => {
      models = value;
    },
    resolve: () => new ProviderActivationService(deps).resolve(bound, f.snapshot.admittedAt),
  };
}
it('selects the bound model independently of a retired default and freezes real descriptor metadata', () => {
  const f = fixture();
  const result = f.resolve();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.provider).toBe(f.provider);
  expect(result.value.snapshot.identity).toMatchObject({
    source: 'connection',
    modelId: 'scripted',
    connectionRevision: 1,
    botProfileVersion: 1,
    endpoint: 'https://fixture.invalid',
  });
  expect(f.descriptors).toEqual([f.record, f.record]);
  expect(Object.isFrozen(result.value.snapshot.capabilities.inputModalities)).toBe(true);
  expect(JSON.stringify(result.value.snapshot)).not.toContain('saved-ref');
  expect(JSON.stringify(result.value.snapshot)).not.toContain('private-key');
});
it('refuses a retired selected model before reading secrets', () => {
  const f = fixture();
  f.models(['other']);
  expect(f.resolve()).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
  expect(f.reads()).toBe(0);
});
it.each(['pending', 'disconnected'] as const)('refuses %s before credentials', (intent) => {
  const f = fixture();
  f.store.put({ ...f.record, intent, revision: 2 }, 1);
  expect(f.resolve().ok).toBe(false);
  expect(f.reads()).toBe(0);
});
it('preserves saved-reference refusal without an external fallback', () => {
  const f = fixture();
  f.deps.secrets.values.clear();
  f.store.put({ ...f.record, revision: 2 }, 1);
  expect(f.resolve().ok).toBe(false);
});
it('admits an eligible persisted revision-zero environment connection and applies restore/disable gates', () => {
  const f = fixture();
  const record = unconfiguredModelConnection('deepseek');
  const provider = { ...f.provider, id: 'deepseek' };
  const factory: ModelCredentialFactory = {
    ...f.deps.factory,
    external: () => ({
      source: 'external',
      provider,
      check: async () => ({ outcome: 'ok', httpStatus: 200, models: ['scripted'] }),
    }),
  };
  const deps = { ...f.deps, factory, connections: { read: () => record } };
  const bound = {
    bot: { ...f.bot, provider: 'deepseek' },
    binding: { connectionId: 'legacy:deepseek', modelId: 'scripted' },
  };
  const result = new ProviderActivationService(deps).resolve(bound, f.snapshot.admittedAt);
  expect(result).toMatchObject({
    ok: true,
    value: { snapshot: { identity: { connectionRevision: 0 } } },
  });
  for (const gate of [{ restored: true }, { disabled: true }])
    expect(
      new ProviderActivationService({ ...deps, ...gate }).resolve(bound, f.snapshot.admittedAt).ok,
    ).toBe(false);
  expect(
    new ProviderActivationService({
      ...deps,
      connections: { read: () => ({ ...record, legacyEnvironment: false }) },
    }).resolve(bound, f.snapshot.admittedAt).ok,
  ).toBe(false);
});
it('refuses missing canonical connection metadata instead of inventing a legacy record', () => {
  const f = fixture();
  expect(
    new ProviderActivationService({ ...f.deps, connections: { read: () => null } }).resolve(
      f.bound,
      f.snapshot.admittedAt,
    ).ok,
  ).toBe(false);
  expect(f.reads()).toBe(0);
  expect(f.descriptors).toEqual([]);
});
it('reads connection metadata from the same active conversation draft as the selected binding', async () => {
  const { DirectChatService } = await import('./direct-chat.js');
  const f = fixture();
  let first = true;
  const store = {
    atomic: <T>(work: Parameters<typeof f.store.atomic<T>>[0]): T =>
      f.store.atomic((tx) => {
        if (first) {
          first = false;
          f.store.modelConnections.put(
            { ...f.record, revision: 2, endpoint: 'https://draft.invalid' },
            1,
          );
        }
        return work(tx);
      }),
  };
  const resolver = new ProviderActivationService(f.deps);
  const result = new DirectChatService({ ...f, store }).submit({ ...f.request, resolver });
  if (!result.ok) throw Error('admission');
  expect(f.store.atomic((tx) => tx.chatTurns()[0]?.activation)).toMatchObject({
    identity: {
      connectionRevision: 2,
      endpoint: 'https://draft.invalid',
    },
  });
  expect((await result.value.completion)?.status).toBe('completed');
});
