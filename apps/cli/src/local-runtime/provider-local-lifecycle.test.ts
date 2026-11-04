import { expect, it } from 'vitest';
import {
  ModelConnectionService,
  ProviderActivationService,
  type ModelConnectionSetInput,
} from '@runnets/application';
import { InMemoryConversationStore } from '@runnets/store';
import { createHash } from 'node:crypto';
import { createProviderActivationFactory } from './provider-activation-factory.js';
import { endpoint, fixture, qualification } from '../../test-fixtures/local-model.js';
const input: ModelConnectionSetInput = {
  connectionId: 'local',
  providerId: 'ollama',
  kind: 'local',
  endpoint,
  auth: 'none',
  defaultModelId: 'qwen3:1.7b',
  requestId: 'set',
  expectedRevision: null,
};
function setup() {
  const http = fixture();
  const store = new InMemoryConversationStore();
  let reads = 0;
  const secret = () => {
    reads++;
    throw Error('unexpected secret effect');
  };
  const secrets = { read: secret, write: secret, replace: secret, remove: secret };
  const factory = createProviderActivationFactory({
    env: new Proxy({}, { get: secret }),
    httpClient: http.http,
  });
  const service = new ModelConnectionService({
    store,
    secrets,
    factory,
    clock: { now: () => new Date('2026-11-04') },
    nextId: () => 'id',
    sha256: (t) => createHash('sha256').update(t).digest('hex'),
  });
  const activation = new ProviderActivationService({
    connections: store,
    secrets,
    factory,
    restored: false,
    disabled: false,
  });
  const bound = {
    bot: {
      id: 'b',
      workspaceId: 'w',
      handle: 'b',
      name: 'B',
      role: 'test',
      provider: 'ollama',
      model: 'qwen3:1.7b',
      profileVersion: 1,
    },
    binding: { connectionId: 'local', modelId: 'qwen3:1.7b' },
  };
  return { http, store, factory, service, activation, bound, reads: () => reads };
}
it('production registry bootstraps without I/O then admits a frozen qualified identity', async () => {
  const f = setup();
  expect(f.service.set(input)).toMatchObject({ state: 'unverified', models: [] });
  expect(f.http.requests).toHaveLength(0);
  expect(f.activation.resolve(f.bound, '2026-11-04T00:00:00Z').ok).toBe(false);
  await f.service.check('local');
  expect(f.store.read('local')?.localQualification).toEqual(qualification);
  const first = f.activation.resolve(f.bound, '2026-11-04T00:00:00Z');
  expect(first.ok).toBe(true);
  if (!first.ok) throw Error('admission failed');
  expect(first.value.snapshot.identity).toMatchObject({
    connectionRevision: 2,
    artifactDigest: 'a'.repeat(64),
    backendVersion: 'fixture-0.1',
  });
  expect(first.value.snapshot.capabilities).toMatchObject({
    contextTokens: 4096,
    maxOutputTokens: null,
  });
  await f.service.check('local');
  expect(f.store.read('local')?.revision).toBe(2);
  expect(first.value.snapshot.identity).toMatchObject({ connectionRevision: 2 });
  expect(f.reads()).toBe(0);
});
it.each([
  { providerId: 'other' },
  { defaultModelId: 'qwen3:8b' },
  { kind: 'cloud' as const },
  { endpoint: 'http://127.0.0.1:11434/proxy' },
  { endpoint: 'https://cloud.invalid' },
])('refuses unregistered local desired settings %j', (patch) => {
  const f = setup();
  expect(() => f.service.set({ ...input, ...patch })).toThrow();
  expect(f.store.read('local')).toBeNull();
  expect(f.http.requests).toHaveLength(0);
  expect(f.reads()).toBe(0);
});
it('keeps admitted providers bound to old evidence after a check publishes a new revision', async () => {
  const f = setup();
  f.service.set(input);
  await f.service.check('local');
  const first = f.activation.resolve(f.bound, '2026-11-04T00:00:00Z');
  if (!first.ok) throw Error('admission');
  const send = f.http.http.send.bind(f.http.http);
  f.http.http.send = async (r) =>
    r.url.endsWith('/api/version')
      ? {
          ok: true,
          status: 200,
          text: async () => '',
          async *stream() {
            yield '{"version":"new-backend"}';
          },
        }
      : send(r);
  const checked = await f.service.check('local');
  expect(checked).toMatchObject({
    check: { revision: 2, persisted: true },
    status: { revision: 3 },
  });
  const events = [];
  for await (const e of first.value.provider.stream({ model: 'qwen3:1.7b', messages: [] }))
    events.push(e);
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'not_sent' } });
  expect(f.http.requests.some((r) => r.url.endsWith('/api/chat'))).toBe(false);
  expect(first.value.snapshot.identity).toMatchObject({
    connectionRevision: 2,
    backendVersion: 'fixture-0.1',
  });
  const next = f.activation.resolve(f.bound, '2026-11-04T00:00:01Z');
  if (!next.ok) throw Error('new admission');
  expect(next.value.snapshot.identity).toMatchObject({
    connectionRevision: 3,
    backendVersion: 'new-backend',
  });
  for await (const _event of next.value.provider.stream({ model: 'qwen3:1.7b', messages: [] })) {
    /* consume */
  }
  expect(f.http.requests.filter((r) => r.url.endsWith('/api/chat'))).toHaveLength(1);
  expect(f.store.read('local')?.revision).toBe(3);
});
it('uses the exact saved key for metadata and verifies teardown before established none mode', async () => {
  const f = setup(),
    keys = new Map<string, string>(),
    effects: string[] = [];
  Object.assign(f.service.options.secrets, {
    read: (ref: string) => {
      effects.push('read:' + ref);
      const key = keys.get(ref);
      return key ? { status: 'ok', key } : { status: 'absent' };
    },
    write: (ref: string, key: string) => {
      effects.push('write:' + ref);
      keys.set(ref, key);
    },
    remove: (ref: string) => {
      effects.push('remove:' + ref);
      keys.delete(ref);
    },
  });
  f.service.set({ ...input, auth: 'api_key', key: 'fixture-saved' });
  expect(f.service.current('local')).toBeNull();
  expect(f.http.requests).toHaveLength(0);
  await f.service.check('local');
  expect(f.http.requests.every((r) => r.headers['authorization'] === 'Bearer fixture-saved')).toBe(
    true,
  );
  f.service.set({ ...input, requestId: 'none', expectedRevision: 2 });
  expect(effects.slice(-2)).toEqual(['remove:psec_id', 'read:psec_id']);
  expect(keys.size).toBe(0);
  expect(f.store.read('local')?.localQualification).toBeNull();
  effects.length = 0;
  f.http.requests.length = 0;
  f.service.status('local');
  await f.service.check('local');
  f.service.current('local');
  expect(effects).toEqual([]);
  expect(f.http.requests.every((r) => r.headers['authorization'] === undefined)).toBe(true);
});
it('keeps unsupported persisted local profiles out of the executable catalog', () => {
  const f = setup();
  expect(
    f.factory.catalog({
      ...input,
      localQualification: {
        ...qualification,
        capabilities: { ...qualification.capabilities, tools: false },
      },
    }),
  ).toEqual([]);
  expect(f.reads()).toBe(0);
});
