import { expect, it } from 'vitest';
import { ModelConnectionService } from './model-connections.js';
import { modelFixture, localSet } from '../test-fixtures/model-connections.js';

it('isolates two same-vendor connections and refuses stale revisions before publication', () => {
  const f = modelFixture(ModelConnectionService);
  expect(f.service.set(localSet('one')).source).toBe('auth_none');
  f.service.set(localSet('two'));
  expect(f.service.list().map((s) => s.connectionId)).toEqual(['one', 'two']);
  expect(() => f.service.set({ ...localSet('one'), requestId: 'stale' })).toThrow(
    'revision_conflict',
  );
  expect(f.secretCalls).toEqual([]);
});

it('uses no secret or external credential for explicit auth-none and freezes public replay', () => {
  const f = modelFixture(ModelConnectionService);
  const first = f.service.set(localSet('one'));
  f.catalog.splice(0);
  f.service.disconnect({ connectionId: 'one', requestId: 'off', expectedRevision: 1 });
  expect(f.service.set(localSet('one'))).toEqual(first);
  expect(f.secretCalls).toEqual([]);
  expect(f.externalCalls).toEqual([]);
  expect(JSON.stringify(first)).not.toMatch(/secretRef|pendingSecretChange|binding|key/);
});

it('refuses missing cloud credentials and invalid endpoints without durable intent', () => {
  const f = modelFixture(ModelConnectionService);
  expect(() =>
    f.service.set({
      ...localSet('one'),
      kind: 'cloud',
      auth: 'api_key',
      endpoint: 'https://api.example.com',
    }),
  ).toThrow('provider_unavailable');
  expect(() => f.service.set({ ...localSet('one'), endpoint: 'http://localhost:8080' })).toThrow(
    'invalid_params',
  );
  expect(f.rows.size).toBe(0);
});

it.each([
  'http://127.1:8080',
  'http://localhost:8080',
  'http://127.0.0.1:8080?key=x',
  'http://user@127.0.0.1:8080',
  'http://127.0.0.1:8080#fragment',
  'http://192.168.1.1:8080',
])('rejects unsafe or noncanonical local endpoint %s before effects', (endpoint) => {
  const f = modelFixture(ModelConnectionService);
  expect(() => f.service.set({ ...localSet('one'), endpoint })).toThrow('invalid_params');
  expect(f.rows.size).toBe(0);
  expect(f.secretCalls).toEqual([]);
});
it('bounds identifiers in UTF-8 bytes and requires explicit none auth without a supplied key', () => {
  const f = modelFixture(ModelConnectionService);
  expect(() => f.service.set({ ...localSet('é'.repeat(129)) })).toThrow('invalid_params');
  expect(() => f.service.set({ ...localSet('one'), key: 'fixture' })).toThrow('invalid_params');
  expect(() => f.service.set({ ...localSet('one'), kind: 'cloud' })).toThrow('invalid_params');
  expect(f.secretCalls).toEqual([]);
});
