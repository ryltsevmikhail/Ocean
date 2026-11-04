import { unconfiguredModelConnection } from './model-connection-ports.js';
import { expect, it } from 'vitest';
import { ModelConnectionService } from './model-connections.js';
import { modelFixture, localSet } from '../test-fixtures/model-connections.js';
import { modelConnectionRecord } from './model-connection-validation.js';
import { fixture, set } from '../test-fixtures/provider-connection-service.js';

it('records exact keyless input before effects and clears it only with activation', () => {
  const f = modelFixture(ModelConnectionService);
  const input = { ...localSet('one'), auth: 'api_key' as const, key: 'synthetic' };
  f.secrets.writeFailure = Error('disk failure');
  expect(() => f.service.set(input)).toThrow('provider_write_failed');
  const { key: _key, ...keyless } = input;
  expect(f.rows.get('one')?.pendingRequest).toEqual({
    version: 1,
    operation: {
      method: 'modelConnections.set',
      input: keyless,
      keyWasSupplied: true,
    },
  });
  const secondOwner = new ModelConnectionService(f.options);
  expect(() => secondOwner.set(keyless)).toThrow('request_conflict');
  f.secrets.writeFailure = null;
  const result = secondOwner.set(input);
  expect(f.rows.get('one')?.pendingRequest).toBeNull();
  expect(secondOwner.set(input)).toEqual(result);
});

it('preserves legacy omission and rejects corrupt envelope versions before publication', () => {
  const f = fixture({ environment: true });
  f.secrets.writeFailure = Error('disk failure');
  expect(() => f.service.set(set)).toThrow('provider_write_failed');
  const row = f.store.connections.read('legacy:deepseek')!;
  expect(row.pendingRequest).toEqual({
    version: 1,
    operation: {
      method: 'provider.set',
      input: { requestId: set.requestId, model: set.model },
      keyWasSupplied: true,
    },
  });
  expect(() => modelConnectionRecord({ ...row, pendingRequest: { version: 2 } })).toThrow(
    'connection_unverified',
  );
  expect(modelConnectionRecord({ ...row, pendingRequest: undefined }).pendingRequest).toBeNull();
});

it.each(['disconnect', 'removeSavedKey'] as const)(
  'reports missing connection before CAS for %s',
  (method) => {
    const f = modelFixture(ModelConnectionService);
    expect(() =>
      f.service[method]({ connectionId: 'absent', requestId: 'missing', expectedRevision: 1 }),
    ).toThrow('connection_not_found');
    expect(f.secretCalls).toEqual([]);
  },
);

import { publishModelSecret } from './model-connection-publication.js';
it('refuses corrupt stored envelopes at the publication boundary before private effects', () => {
  const f = modelFixture(ModelConnectionService);
  const input = { ...localSet('one'), auth: 'api_key' as const, key: 'synthetic' };
  f.secrets.writeFailure = Error('disk failure');
  expect(() => f.service.set(input)).toThrow('provider_write_failed');
  const pending = f.rows.get('one')!;
  const corrupt = { ...pending, pendingRequest: { version: 2 } };
  f.secretCalls.splice(0);
  expect(() =>
    publishModelSecret(corrupt as unknown as typeof pending, input.key, f.secrets),
  ).toThrow('connection_unverified');
  expect(f.secretCalls).toEqual([]);
});

it('rejects present inconsistent envelopes instead of treating them as missing history', () => {
  const f = modelFixture(ModelConnectionService);
  f.secrets.writeFailure = Error('disk failure');
  const input = { ...localSet('one'), auth: 'api_key' as const, key: 'synthetic' };
  expect(() => f.service.set(input)).toThrow('provider_write_failed');
  const row = f.rows.get('one')!;
  const original = row.pendingRequest!;
  const op = original.operation;
  if (op.method !== 'modelConnections.set') throw Error('fixture');
  for (const pendingRequest of [
    [],
    { ...original, version: ['1'] },
    { ...original, extra: 'secret' },
    { ...original, operation: { ...op, keyWasSupplied: ['true'] } },
    { ...original, operation: { ...op, input: { ...op.input, expectedRevision: 1 } } },
    { ...original, operation: { ...op, input: { ...op.input, connectionId: 'foreign' } } },
    { ...original, operation: { ...op, input: { ...op.input, key: 'unexpected' } } },
  ])
    expect(() => modelConnectionRecord({ ...row, pendingRequest })).toThrow(
      'connection_unverified',
    );
});

it('retains historical no-envelope recovery only with exact owner input', () => {
  const f = modelFixture(ModelConnectionService);
  const input = { ...localSet('one'), auth: 'api_key' as const, key: 'synthetic' };
  f.secrets.writeFailure = Error('disk failure');
  expect(() => f.service.set(input)).toThrow('provider_write_failed');
  const row = f.rows.get('one')!;
  f.rows.set('one', { ...row, pendingRequest: null });
  f.secrets.writeFailure = null;
  expect(() => f.service.set({ ...input, requestId: 'supersede', expectedRevision: 1 })).toThrow(
    'provider_unverified',
  );
  expect(f.service.set(input).revision).toBe(1);
});

it('preserves zero create envelopes and the set-to-none removal method', () => {
  const f = modelFixture(ModelConnectionService);
  const initial = {
    ...unconfiguredModelConnection('fixture'),
    connectionId: 'one',
    kind: 'local' as const,
    endpoint: localSet('one').endpoint,
  };
  f.rows.set('one', initial);
  const input = {
    ...localSet('one'),
    expectedRevision: 0,
    auth: 'api_key' as const,
    key: 'synthetic',
  };
  f.secrets.writeFailure = Error('disk failure');
  expect(() => f.service.set(input)).toThrow('provider_write_failed');
  expect(f.rows.get('one')?.pendingRequest?.operation).toMatchObject({
    method: 'modelConnections.set',
    input: { expectedRevision: 0 },
  });
  f.secrets.writeFailure = null;
  f.service.set(input);
  f.secrets.removeFailure = Error('disk failure');
  expect(() =>
    f.service.set({ ...localSet('one'), requestId: 'none', expectedRevision: 1 }),
  ).toThrow('provider_write_failed');
  expect(f.rows.get('one')?.pendingRequest?.operation).toMatchObject({
    method: 'modelConnections.set',
    keyWasSupplied: false,
    input: { auth: 'none' },
  });
});

it('checks envelope consistency with resubmitted original input in addition to its private binding', () => {
  const f = modelFixture(ModelConnectionService);
  const input = { ...localSet('one'), auth: 'api_key' as const, key: 'synthetic' };
  f.secrets.writeFailure = Error('disk failure');
  expect(() => f.service.set(input)).toThrow();
  const row = f.rows.get('one')!;
  const op = row.pendingRequest!.operation;
  if (op.method !== 'modelConnections.set') throw Error('fixture');
  f.rows.set('one', {
    ...row,
    pendingRequest: {
      version: 1,
      operation: { ...op, input: { ...op.input, expectedRevision: 0 } },
    },
  });
  f.secretCalls.splice(0);
  expect(() => f.service.set(input)).toThrow('connection_unverified');
  expect(f.secretCalls).toEqual([]);
});
