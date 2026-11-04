import { expect, it, vi } from 'vitest';
import { ModelConnectionService } from './model-connections.js';
import { modelFixture, localSet } from '../test-fixtures/model-connections.js';
import { fixture, set } from '../test-fixtures/provider-connection-service.js';

const supersessions = ['set', 'disconnect', 'remove'] as const;
const cases = (['remove', 'replace'] as const).flatMap((failure) =>
  supersessions.map((action) => ({ failure, action })),
);
const cloud = {
  ...localSet('one'),
  kind: 'cloud' as const,
  auth: 'api_key' as const,
  endpoint: 'https://api.example.com',
  key: 'first-key',
};

it.each(cases)(
  'retains $failure recovery authority when a different v2 $action is refused',
  ({ failure, action }) => {
    const f = modelFixture(ModelConnectionService);
    f.service.set(cloud);
    const previousRef = f.rows.get('one')!.secretRef!;
    const original =
      failure === 'remove'
        ? () =>
            f.service.removeSavedKey({
              connectionId: 'one',
              requestId: 'pending',
              expectedRevision: 1,
            })
        : () =>
            f.service.set({
              ...cloud,
              requestId: 'pending',
              expectedRevision: 1,
              key: 'second-key',
            });
    if (failure === 'remove') f.secrets.removeFailure = Error('disk failure');
    else f.secrets.replaceFailure = Error('disk failure');
    expect(original).toThrow('provider_write_failed');
    const pending = structuredClone(f.rows.get('one'));
    expect(pending!.pendingSecretChange!.previousRef).toBe(previousRef);
    const values = [...f.secrets.values];
    const receipts = [...f.receipts];
    f.secrets.removeFailure = null;
    f.secrets.replaceFailure = null;
    f.secretCalls.splice(0);
    const other = { connectionId: 'one', requestId: 'supersede', expectedRevision: 2 };
    const supersede = () =>
      action === 'set'
        ? f.service.set({ ...cloud, ...other, key: 'third-key' })
        : action === 'disconnect'
          ? f.service.disconnect(other)
          : f.service.removeSavedKey(other);
    expect(supersede).toThrow('provider_unverified');
    expect(f.rows.get('one')).toEqual(pending);
    expect([...f.secrets.values]).toEqual(values);
    expect([...f.receipts]).toEqual(receipts);
    expect(f.secretCalls).toEqual([]);
    f.secrets.removeFailure = null;
    f.secrets.replaceFailure = null;
    const recovered = original();
    expect(recovered.revision).toBe(2);
    expect(f.rows.get('one')!.pendingSecretChange).toBeNull();
    expect(f.secrets.values.has(previousRef)).toBe(false);
    expect(f.secrets.values.size).toBe(failure === 'remove' ? 0 : 1);
    expect(original()).toEqual(recovered);
  },
);

it.each(cases)(
  'retains $failure recovery authority through the legacy $action facade',
  ({ failure, action }) => {
    const f = fixture({ environment: true });
    f.service.set(set);
    const original =
      failure === 'remove'
        ? () => f.service.removeSavedKey({ requestId: 'pending', expectedRevision: 1 })
        : () => f.service.set({ ...set, requestId: 'pending', key: 'second-key' });
    if (failure === 'remove') f.secrets.removeFailure = Error('disk failure');
    else f.secrets.replaceFailure = Error('disk failure');
    expect(original).toThrow('provider_write_failed');
    const pending = f.store.connections.read('legacy:deepseek')!;
    const values = [...f.secrets.values];
    const receipts = [...f.store.receipts];
    const writes = f.secrets.writes.length;
    const replaces = f.secrets.replaces.length;
    f.secrets.removeFailure = null;
    f.secrets.replaceFailure = null;
    const other = { requestId: 'supersede', expectedRevision: 2 };
    const supersede = () =>
      action === 'set'
        ? f.service.set({ ...set, ...other, key: 'third-key' })
        : action === 'disconnect'
          ? f.service.disconnect(other)
          : f.service.removeSavedKey(other);
    expect(supersede).toThrow('provider_unverified');
    expect(f.store.connections.read('legacy:deepseek')).toEqual(pending);
    expect([...f.secrets.values]).toEqual(values);
    expect([...f.store.receipts]).toEqual(receipts);
    expect(f.secrets.writes).toHaveLength(writes);
    expect(f.secrets.replaces).toHaveLength(replaces);
    f.secrets.removeFailure = null;
    f.secrets.replaceFailure = null;
    const recovered = original();
    expect(recovered.revision).toBe(2);
    expect(f.store.connections.read('legacy:deepseek')!.pendingSecretChange).toBeNull();
    expect(f.secrets.values.has(pending.pendingSecretChange!.previousRef!)).toBe(false);
    expect(f.secrets.values.size).toBe(failure === 'remove' ? 0 : 1);
    expect(original()).toEqual(recovered);
  },
);

it('keeps legacy null-intent inert except a new explicit-key repair, then protects that known repair', () => {
  const f = fixture({ environment: true });
  f.service.set(set);
  const saved = f.store.connections.read('legacy:deepseek')!;
  const unknown = { ...saved, intent: 'pending' as const, pendingSecretChange: null };
  f.store.connections.put(unknown, saved.revision);
  f.store.receipts.delete(set.requestId);
  const read = vi.spyOn(f.secrets, 'read');
  const values = [...f.secrets.values];
  for (const action of [
    () => f.service.set({ requestId: 'model-only', model: set.model }),
    () => f.service.disconnect({ requestId: 'off', expectedRevision: 1 }),
    () => f.service.removeSavedKey({ requestId: 'remove', expectedRevision: 1 }),
    () => f.service.set(set),
  ]) {
    read.mockClear();
    expect(action).toThrow('provider_unverified');
    expect(read).not.toHaveBeenCalled();
    expect(f.store.connections.read('legacy:deepseek')).toEqual(unknown);
    expect([...f.secrets.values]).toEqual(values);
  }
  const repair = { ...set, requestId: 'repair', key: 'repair-key' };
  f.secrets.replaceFailure = Error('disk failure');
  expect(() => f.service.set(repair)).toThrow('provider_write_failed');
  const pending = f.store.connections.read('legacy:deepseek')!;
  expect(pending.pendingSecretChange).toEqual({
    action: 'replace',
    previousRef: unknown.secretRef,
    nextRef: pending.secretRef,
  });
  f.secrets.replaceFailure = null;
  expect(() => f.service.set({ ...repair, requestId: 'another' })).toThrow('provider_unverified');
  expect(f.store.connections.read('legacy:deepseek')).toEqual(pending);
  const result = f.service.set(repair);
  expect(result).toMatchObject({ source: 'saved', revision: 2 });
  expect(f.secrets.values.has(unknown.secretRef!)).toBe(false);
  expect(f.service.set(repair)).toEqual(result);
  expect(f.store.receipts.has(set.requestId)).toBe(false);
});
