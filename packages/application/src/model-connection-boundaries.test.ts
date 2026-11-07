import { expect, it, vi } from 'vitest';
import { ModelConnectionService } from './model-connections.js';
import { modelFixture, localSet } from '../test-fixtures/model-connections.js';
import { unconfiguredModelConnection } from './model-connection-ports.js';
import { fixture, set, sha256 } from '../test-fixtures/provider-connection-service.js';
import { bindingFor, keyDigest } from './provider-connection-request.js';
const cloud = (id: string) => ({
  ...localSet(id),
  kind: 'cloud' as const,
  auth: 'api_key' as const,
  endpoint: 'https://api.example.com',
  key: 'fixture-key',
});

it('recovers replacement after a private publication failure with its persisted old and new references', () => {
  const f = modelFixture(ModelConnectionService);
  f.service.set(cloud('one'));
  const previous = f.rows.get('one')!.secretRef!;
  f.secrets.replaceFailure = Error('disk failure');
  const rotate = { ...cloud('one'), requestId: 'rotate', expectedRevision: 1, key: 'second-key' };
  expect(() => f.service.set(rotate)).toThrow('provider_write_failed');
  const pending = f.rows.get('one')!;
  expect(pending.pendingSecretChange).toEqual({
    action: 'replace',
    previousRef: previous,
    nextRef: pending.secretRef,
  });
  expect(f.service.status('one').state).toBe('unverified');
  f.secrets.replaceFailure = null;
  f.secretCalls.splice(0);
  expect(new ModelConnectionService(f.options).set(rotate).revision).toBe(2);
  expect(f.secrets.replaces.at(-1)).toEqual({ previous, ref: pending.secretRef });
  expect([...f.secrets.values.values()]).toEqual(['second-key']);
});

it('keeps intent pending when public receipt commit fails after private publication and retries once', () => {
  const f = modelFixture(ModelConnectionService);
  const activate = f.store.activate;
  f.store.activate = () => {
    throw Error('receipt failure');
  };
  expect(() => f.service.set(cloud('one'))).toThrow('receipt failure');
  const pending = f.rows.get('one')!;
  expect(pending.intent).toBe('pending');
  expect(f.secrets.values.get(pending.secretRef!)).toBe('fixture-key');
  expect(f.receipts.size).toBe(0);
  f.store.activate = activate;
  const result = new ModelConnectionService(f.options).set(cloud('one'));
  expect(result.revision).toBe(1);
  expect(f.service.set(cloud('one'))).toEqual(result);
  expect(f.rows.get('one')!.secretRef).toBe(pending.secretRef);
});

it('does not activate unrecoverable legacy pending metadata through a model-only update', () => {
  const f = modelFixture(ModelConnectionService);
  f.rows.set('one', {
    ...unconfiguredModelConnection('fixture'),
    connectionId: 'one',
    providerId: 'fixture',
    kind: 'cloud',
    auth: 'api_key',
    endpoint: 'https://api.example.com',
    defaultModelId: 'fixture-model',
    revision: 1,
    intent: 'pending',
    secretRef: 'unknown',
    requestId: 'old',
    binding: 'old',
    pendingSecretChange: null,
    legacyEnvironment: false,
  });
  const { key: _key, ...update } = cloud('one');
  expect(() => f.service.set({ ...update, expectedRevision: 1, requestId: 'update' })).toThrow(
    'provider_unverified',
  );
  expect(f.secretCalls).toEqual([]);
  expect(f.externalCalls).toEqual([]);
});

it('recovers removal and explicit api-key to none transition without retaining the old secret', () => {
  const f = modelFixture(ModelConnectionService);
  f.service.set({ ...cloud('one'), kind: 'local', endpoint: 'http://127.0.0.1:8080' });
  f.secrets.removeFailure = Error('disk failure');
  const update = { ...localSet('one'), expectedRevision: 1, requestId: 'none' };
  expect(() => f.service.set(update)).toThrow('provider_write_failed');
  expect(f.rows.get('one')!.pendingSecretChange?.action).toBe('remove');
  expect(f.secrets.values.size).toBe(1);
  f.secrets.removeFailure = null;
  expect(new ModelConnectionService(f.options).set(update)).toMatchObject({
    source: 'auth_none',
    savedKey: false,
    revision: 2,
  });
  expect(f.secrets.values.size).toBe(0);
});

it('pins exact public result across delayed checks, rotation, catalog and host restore changes with no replay reads', async () => {
  const f = modelFixture(ModelConnectionService);
  const result = f.service.set(cloud('one'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.factory.activate;
  f.factory.activate = (d, s) => {
    const credential = original(d, s);
    return credential === null
      ? null
      : {
          ...credential,
          check: async () => {
            await gate;
            return { outcome: 'ok', httpStatus: 200, models: ['fixture-model'] };
          },
        };
  };
  const check = f.service.check('one');
  f.service.set({ ...cloud('one'), requestId: 'rotate', expectedRevision: 1, key: 'second' });
  release();
  expect((await check).check.persisted).toBe(false);
  f.catalog.splice(0);
  f.secretCalls.splice(0);
  f.factory.catalog = vi.fn(() => {
    throw Error('unexpected catalog');
  });
  f.factory.activate = vi.fn(() => {
    throw Error('unexpected activation');
  });
  f.factory.external = vi.fn(() => {
    throw Error('unexpected external');
  });
  expect(new ModelConnectionService({ ...f.options, restored: true }).set(cloud('one'))).toEqual(
    result,
  );
  expect(f.secretCalls).toEqual([]);
  expect(f.factory.catalog).not.toHaveBeenCalled();
  expect(f.factory.activate).not.toHaveBeenCalled();
  expect(f.factory.external).not.toHaveBeenCalled();
});

it('keeps restored siblings inert and never speculates an external fallback for false eligibility', () => {
  const f = modelFixture(ModelConnectionService, { restored: true });
  for (const id of ['one', 'two'])
    f.rows.set(id, {
      ...unconfiguredModelConnection('fixture'),
      ...localSet(id),
      revision: 1,
      intent: 'active',
      configuredAfterRestore: false,
    });
  expect(f.service.status('two').state).toBe('restored');
  f.service.set({ ...localSet('one'), requestId: 'reconfigure', expectedRevision: 1 });
  expect(f.service.status('one').source).toBe('auth_none');
  expect(f.service.status('two').state).toBe('restored');
  f.rows.set('cloud', {
    ...unconfiguredModelConnection('fixture'),
    connectionId: 'cloud',
    revision: 1,
    intent: 'active',
    configuredAfterRestore: true,
  });
  expect(f.service.status('cloud').state).toBe('absent');
  expect(f.externalCalls).toEqual([]);
});

it('refuses cross-connection and cross-generation request IDs before any credential effects', () => {
  const f = modelFixture(ModelConnectionService);
  f.service.set(cloud('one'));
  f.secretCalls.splice(0);
  expect(() => f.service.set({ ...cloud('two'), requestId: 'set-one' })).toThrow(
    'request_conflict',
  );
  f.legacyReceipts.set('legacy', { binding: 'old', result: fixture().service.status() });
  expect(() => f.service.set({ ...cloud('two'), requestId: 'legacy' })).toThrow('request_conflict');
  expect(f.rows.has('two')).toBe(false);
  expect(f.secretCalls).toEqual([]);
});

it('refuses historical internal receipts with no public snapshot without effects', () => {
  const f = modelFixture(ModelConnectionService);
  f.service.set(cloud('one'));
  const receipt = f.receipts.get('set-one')!;
  f.receipts.set('set-one', { binding: receipt.binding, result: receipt.result });
  f.secretCalls.splice(0);
  expect(() => f.service.set(cloud('one'))).toThrow('receipt_result_unavailable');
  expect(f.secretCalls).toEqual([]);
});

it('preserves exact legacy keys, check DTO, fingerprints and replay ahead of changing catalog', async () => {
  const f = fixture();
  const result = f.service.set(set);
  expect(Object.keys(result)).toEqual([
    'provider',
    'source',
    'state',
    'model',
    'models',
    'modelCapabilities',
    'revision',
    'savedKey',
    'writable',
    'code',
    'lastCheck',
  ]);
  expect(f.store.receipts.get(set.requestId)!.binding).toBe(
    bindingFor(sha256, ['ProviderSet', 'deepseek', set.model, keyDigest(sha256, set.key)]),
  );
  const checked = await f.service.check();
  expect(Object.keys(checked.check)).toEqual([
    'outcome',
    'httpStatus',
    'durationMs',
    'models',
    'modelSupported',
    'source',
    'revision',
    'checkedAt',
    'persisted',
  ]);
  expect(JSON.stringify(checked)).not.toContain('connectionId');
  Object.assign(f.credentials, { models: [] });
  f.secrets.readOverride = () => {
    throw Error('unexpected secret read');
  };
  expect(f.service.set(set)).toEqual(result);
});

it('reserves an interrupted request across connections before a second private effect', () => {
  const f = modelFixture(ModelConnectionService);
  f.secrets.writeFailure = Error('disk failure');
  expect(() => f.service.set(cloud('one'))).toThrow('provider_write_failed');
  f.secrets.writeFailure = null;
  f.secretCalls.splice(0);
  expect(() => f.service.set({ ...cloud('two'), requestId: 'set-one' })).toThrow(
    'request_conflict',
  );
  expect(f.rows.has('two')).toBe(false);
  expect(f.secretCalls).toEqual([]);
});
