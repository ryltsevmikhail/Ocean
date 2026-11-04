import { describe, expect, it } from 'vitest';
import { ProviderConnectionService } from './provider-connections.js';
import type { ChatMessage } from './provider.js';
import {
  environmentCredential,
  fakeCredentials,
  fakeSecrets,
  fakeStore,
  type FakeProvider,
} from '../test-fixtures/provider-connection-fakes.js';

const sha256 = (text: string) => text;
function service(options: { restored?: boolean; mutationsAllowed?: boolean } = {}) {
  const store = fakeStore();
  const secrets = fakeSecrets();
  const credentials = fakeCredentials();
  let ids = 0;
  const built = new ProviderConnectionService({
    store,
    secrets,
    credentials,
    clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
    nextId: () => (++ids).toString(16).padStart(32, '0'),
    sha256,
    ...(options.restored === true ? { restored: true } : {}),
    ...(options.mutationsAllowed === undefined
      ? {}
      : { mutationsAllowed: options.mutationsAllowed }),
  });
  built.initialize();
  return { service: built, store, secrets, credentials };
}
const messages: ChatMessage[] = [{ role: 'user', content: 'dispatch this turn' }];
async function collect(provider: FakeProvider): Promise<string[]> {
  const text: string[] = [];
  for await (const event of provider.stream({ model: 'deepseek-flash', messages }))
    if (event.type === 'text_delta') text.push(event.text);
  return text;
}
const setA = { requestId: 'set-a', key: 'sk-fixture-key-a', model: 'deepseek-flash' };

describe('provider activation snapshot', () => {
  it('keeps an already admitted turn on its captured provider when the key rotates mid-flight', async () => {
    const f = service();
    f.service.set(setA);
    const admitted = f.service.current() as FakeProvider;
    let release!: () => void;
    admitted.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = collect(admitted);
    // Rotation happens while the admitted turn is blocked inside its provider call.
    f.service.set({ requestId: 'set-b', key: 'sk-fixture-key-b', model: 'deepseek-flash' });
    release();
    expect(await turn).toEqual(['fixture sk-fixture-key-a']);
    expect(admitted.calls).toEqual(['sk-fixture-key-a:deepseek-flash']);
    // The admitted snapshot stays valid for that turn only; later turns see the new activation.
    const later = f.service.current() as FakeProvider;
    expect(later).not.toBe(admitted);
    expect(later.key).toBe('sk-fixture-key-b');
    expect(await collect(later)).toEqual(['fixture sk-fixture-key-b']);
    expect(admitted.calls).toHaveLength(1);
  });

  it('does not cancel or replay an admitted turn when the connection disconnects', async () => {
    const f = service();
    f.service.set(setA);
    const admitted = f.service.current() as FakeProvider;
    let release!: () => void;
    admitted.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turn = collect(admitted);
    f.service.disconnect({ requestId: 'off', expectedRevision: 1 });
    release();
    expect(await turn).toEqual(['fixture sk-fixture-key-a']);
    expect(admitted.calls).toHaveLength(1);
    expect(f.service.current()).toBeNull();
  });

  it('hands the turns owner a getter instead of a fixed provider', () => {
    const f = service();
    const activate = f.service.activation();
    expect(activate()).toBeNull();
    f.service.set(setA);
    const first = activate();
    expect(first).not.toBeNull();
    f.service.set({ requestId: 'set-b', key: 'sk-fixture-key-b', model: 'deepseek-v4-pro' });
    expect(activate()).not.toBe(first);
    expect((activate() as FakeProvider).key).toBe('sk-fixture-key-b');
  });

  it('reports an injected provider as the read-only session activation', () => {
    const injected: FakeProvider = {
      key: 'injected',
      calls: [],
      gate: null,
      id: 'deepseek',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      capabilities: { streaming: true, reasoning: false, usage: true },
      async *stream() {
        yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
      },
    };
    const store = fakeStore();
    const secrets = fakeSecrets();
    const credentials = fakeCredentials();
    const settings = new ProviderConnectionService({
      store,
      secrets,
      credentials,
      clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
      nextId: () => 'injected',
      sha256,
      injected,
    });
    settings.initialize();
    expect(settings.status()).toMatchObject({
      source: 'injected',
      state: 'connected',
      model: 'deepseek-flash',
      writable: false,
    });
    expect(settings.current()).toBe(injected);
    expect(() => settings.set(setA)).toThrow('provider_injected');
    expect(() => settings.disconnect({ requestId: 'x', expectedRevision: 0 })).toThrow(
      'provider_injected',
    );
    expect(credentials.probes).toHaveLength(0);
  });

  it('stays inert on a restored profile even with readable saved bytes and an environment value', () => {
    const f = service({ restored: true });
    f.credentials.setEnvironment(environmentCredential());
    f.secrets.values.set('psec_restored', 'sk-fixture-key-a');
    f.store.rows.set('deepseek', {
      provider: 'deepseek',
      model: 'deepseek-flash',
      secretRef: 'psec_restored',
      intent: 'active',
      revision: 4,
      requestId: 'before-restore',
      binding: 'before',
      lastCheck: null,
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    f.service.initialize();
    expect(f.service.status()).toMatchObject({
      source: 'none',
      state: 'restored',
      model: null,
      savedKey: true,
      revision: 4,
    });
    expect(f.service.current()).toBeNull();
    // Only an explicit owner configuration clears the inert restored state.
    const configured = f.service.set({
      requestId: 'after-restore',
      key: 'sk-fixture-key-b',
      model: 'deepseek-flash',
    });
    expect(configured).toMatchObject({ source: 'saved', state: 'connected', revision: 5 });
    expect((f.service.current() as FakeProvider).key).toBe('sk-fixture-key-b');
  });
});
