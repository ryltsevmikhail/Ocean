import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ProviderConnectionService,
  unconfiguredModelConnection,
  type ProviderCredentialPort,
  type ProviderSecretRead,
} from '@runnets/application';
import { initializeSchema } from './schema.js';
import { SqliteModelConnections } from './model-connection-storage.js';
import { SqliteProviderConnections } from './provider-connection-storage.js';

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function setup(providerId: string) {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  initializeSchema(db);
  const models = new SqliteModelConnections(db);
  const stream = vi.fn(async function* () {
    yield { type: 'text_delta' as const, text: 'unexpected' };
  });
  const provider = {
    id: providerId,
    models: ['model'],
    capabilities: { streaming: true, reasoning: false, usage: false },
    stream,
  };
  const environment = vi.fn(() => ({
    source: 'external' as const,
    provider,
    check: () => Promise.resolve({ outcome: 'ok' as const, httpStatus: 200, models: ['model'] }),
  }));
  const own = vi.fn(() => ({
    source: 'saved' as const,
    provider,
    check: () => Promise.resolve({ outcome: 'ok' as const, httpStatus: 200, models: ['model'] }),
  }));
  const values = new Map<string, string>();
  const read = vi.fn((ref: string): ProviderSecretRead =>
    values.has(ref) ? { status: 'ok', key: values.get(ref)! } : { status: 'absent' },
  );
  const secrets = {
    read,
    write: vi.fn((ref: string, key: string) => {
      values.set(ref, key);
    }),
    replace: vi.fn((previous: string | null, ref: string, key: string) => {
      if (previous !== null) values.delete(previous);
      values.set(ref, key);
    }),
    remove: vi.fn((ref: string) => {
      values.delete(ref);
    }),
  };
  const credentials: ProviderCredentialPort = {
    providerId,
    models: ['model'],
    modelCapabilities: [],
    environment,
    own,
  };
  const legacy = new SqliteProviderConnections(db);
  const service = new ProviderConnectionService({
    store: legacy,
    credentials,
    secrets,
    clock: { now: () => new Date('2026-11-04T00:00:00Z') },
    nextId: () => 'id',
    sha256: (text) => text,
  });
  return { db, models, legacy, service, environment, own, stream, read, secrets, values };
}
it.each(['deepseek', 'unknown'])(
  'refuses an ineligible %s placeholder before touching environment, keys or model calls',
  (providerId) => {
    const c = setup(providerId);
    c.models.put(
      { ...unconfiguredModelConnection(providerId), legacyEnvironment: false },
      providerId === 'deepseek' ? 0 : null,
    );
    expect(() => c.legacy.read(providerId)).toThrow('provider_unverified');
    expect(() => c.service.initialize()).toThrow('provider_unverified');
    expect(c.environment).not.toHaveBeenCalled();
    expect(c.own).not.toHaveBeenCalled();
    expect(c.read).not.toHaveBeenCalled();
    expect(c.stream).not.toHaveBeenCalled();
    expect(c.models.read('legacy:' + providerId)).toMatchObject({
      intent: 'unconfigured',
      revision: 0,
      secretRef: null,
      legacyEnvironment: false,
    });
  },
);
it('retains the shipped DeepSeek environment seam only for its eligible placeholder', () => {
  const c = setup('deepseek');
  expect(c.legacy.read('deepseek')).toBeNull();
  c.service.initialize();
  expect(c.service.status()).toMatchObject({ state: 'connected', source: 'external', revision: 0 });
  expect(c.environment).toHaveBeenCalled();
  expect(c.own).not.toHaveBeenCalled();
  expect(c.read).not.toHaveBeenCalled();
  expect(c.stream).not.toHaveBeenCalled();
});
it('refuses an active canonical row that explicitly blocks environment use', () => {
  const c = setup('deepseek');
  c.models.put(
    {
      ...unconfiguredModelConnection('deepseek'),
      intent: 'active',
      revision: 1,
      legacyEnvironment: false,
    },
    0,
  );
  expect(() => c.service.initialize()).toThrow('provider_unverified');
  expect(c.environment).not.toHaveBeenCalled();
  expect(c.own).not.toHaveBeenCalled();
  expect(c.read).not.toHaveBeenCalled();
  expect(c.stream).not.toHaveBeenCalled();
});
it('preserves an explicitly eligible active external-key connection', () => {
  const c = setup('deepseek');
  c.models.put(
    {
      ...unconfiguredModelConnection('deepseek'),
      intent: 'active',
      revision: 1,
      legacyEnvironment: true,
    },
    0,
  );
  c.service.initialize();
  expect(c.service.status()).toMatchObject({ state: 'connected', source: 'external', revision: 1 });
  expect(c.environment).toHaveBeenCalled();
  expect(c.own).not.toHaveBeenCalled();
  expect(c.read).not.toHaveBeenCalled();
  expect(c.stream).not.toHaveBeenCalled();
});

it('blocks saved-key removal and direct legacy mutations on a restricted canonical row before secret effects', () => {
  const c = setup('deepseek');
  const restricted = {
    ...unconfiguredModelConnection('deepseek'),
    intent: 'active' as const,
    revision: 1,
    legacyEnvironment: false,
    secretRef: 'saved-ref',
    defaultModelId: 'model',
  };
  c.models.put(restricted, 0);
  c.values.set('saved-ref', 'fixture');
  expect(() => c.service.removeSavedKey({ requestId: 'remove', expectedRevision: 1 })).toThrow(
    'provider_unverified',
  );
  const old = {
    provider: 'deepseek',
    model: 'model',
    secretRef: null,
    intent: 'pending' as const,
    revision: 2,
    requestId: 'direct',
    binding: 'digest',
    lastCheck: null,
    updatedAt: 'then',
  };
  expect(() => c.legacy.put(old, 1)).toThrow('provider_unverified');
  expect(() =>
    c.legacy.activate(old, 1, {
      requestId: 'direct',
      value: {
        binding: 'digest',
        result: {
          provider: 'deepseek',
          source: 'none',
          state: 'disconnected',
          model: 'model',
          models: ['model'],
          modelCapabilities: [],
          revision: 2,
          savedKey: false,
          writable: true,
          code: null,
          lastCheck: null,
        },
      },
    }),
  ).toThrow('provider_unverified');
  expect(c.legacy.receipt('direct')).toBeNull();
  expect(c.models.read('legacy:deepseek')).toEqual(restricted);
  for (const call of [
    c.environment,
    c.own,
    c.read,
    c.stream,
    c.secrets.write,
    c.secrets.replace,
    c.secrets.remove,
  ])
    expect(call).not.toHaveBeenCalled();
});
it('keeps designated fallback eligibility through legacy key publication, removal and disconnect', () => {
  const c = setup('deepseek');
  expect(c.service.set({ requestId: 'set', key: 'fixture', model: 'model' })).toMatchObject({
    state: 'connected',
    source: 'saved',
    revision: 1,
  });
  expect(c.models.read('legacy:deepseek')).toMatchObject({
    legacyEnvironment: true,
    intent: 'active',
  });
  expect(c.service.removeSavedKey({ requestId: 'remove', expectedRevision: 1 })).toMatchObject({
    state: 'connected',
    source: 'external',
    revision: 2,
  });
  expect(c.models.read('legacy:deepseek')).toMatchObject({
    legacyEnvironment: true,
    intent: 'active',
    secretRef: null,
  });
  expect(c.service.disconnect({ requestId: 'disconnect', expectedRevision: 2 })).toMatchObject({
    state: 'disconnected',
    source: 'none',
    revision: 3,
  });
  expect(c.models.read('legacy:deepseek')).toMatchObject({
    legacyEnvironment: true,
    intent: 'disconnected',
  });
  expect(c.service.current()).toBeNull();
  expect(c.stream).not.toHaveBeenCalled();
});

it.each(
  ['pending', 'disconnected'].flatMap((intent) =>
    [null, 'saved-ref'].map((secretRef) => ({ intent, secretRef })),
  ),
)(
  'rejects persisted [$intent] with secretRef=$secretRef before any credential or model effects',
  ({ intent, secretRef }) => {
    const c = setup('deepseek');
    c.values.set('saved-ref', 'fixture');
    c.db.prepare('UPDATE ocean_model_connections SET payload=?').run(
      JSON.stringify({
        ...unconfiguredModelConnection('deepseek'),
        revision: 1,
        intent: [intent],
        secretRef,
      }),
    );
    expect(() => c.service.initialize()).toThrow('connection_unverified');
    expect(c.service.current()).toBeNull();
    for (const call of [
      c.environment,
      c.own,
      c.read,
      c.stream,
      c.secrets.write,
      c.secrets.replace,
      c.secrets.remove,
    ])
      expect(call).not.toHaveBeenCalled();
  },
);
