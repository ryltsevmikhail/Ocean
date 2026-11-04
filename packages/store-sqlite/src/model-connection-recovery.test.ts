import { expect, it } from 'vitest';
import { type ModelConnectionSetInput } from '@runnets/application';
import { modelRecovery } from '../test-fixtures/model-recovery.js';

const input: ModelConnectionSetInput = {
  connectionId: 'one',
  requestId: 'initial',
  expectedRevision: null,
  providerId: 'fixture',
  kind: 'cloud',
  auth: 'api_key',
  endpoint: 'https://api.example.com',
  defaultModelId: 'model',
  key: 'first-synthetic-key',
};
const cases = (['remove', 'replace'] as const).flatMap((failure) =>
  (['publication', 'receipt'] as const).map((phase) => ({ failure, phase })),
);
it.each(cases)(
  'durably preserves $failure authority after $phase failure until original-request recovery',
  ({ failure, phase }) => {
    const f = modelRecovery();
    f.service.set(input);
    const oldRef = f.store.read('one')!.secretRef!;
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
              ...input,
              requestId: 'pending',
              expectedRevision: 1,
              key: 'second-synthetic-key',
            });
    if (phase === 'publication') f.controls.fail = failure;
    else
      f.db.exec(
        "CREATE TRIGGER reject_pending BEFORE INSERT ON ocean_model_connection_receipts WHEN NEW.request_id='pending' BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
      );
    expect(original).toThrow(phase === 'publication' ? 'provider_write_failed' : 'receipt failure');
    const pending = f.store.read('one')!;
    expect(pending.pendingSecretChange).toEqual({
      action: failure,
      previousRef: oldRef,
      nextRef: failure === 'remove' ? null : pending.secretRef,
    });
    const nextRef = pending.pendingSecretChange!.nextRef;
    f.reopen();
    expect(f.store.read('one')).toEqual(pending);
    expect(f.store.receipt('pending')).toBeNull();
    f.controls.fail = null;
    for (const action of ['set', 'disconnect', 'remove'] as const) {
      const revision = {
        connectionId: 'one',
        requestId: `supersede-${action}`,
        expectedRevision: 2,
      };
      const previousSecret = f.privateStore.read(oldRef);
      const nextSecret = nextRef === null ? null : f.privateStore.read(nextRef);
      f.calls.splice(0);
      const supersede = () =>
        action === 'set'
          ? f.service.set({ ...input, ...revision, key: 'third-synthetic-key' })
          : action === 'disconnect'
            ? f.service.disconnect(revision)
            : f.service.removeSavedKey(revision);
      expect(supersede).toThrow('provider_unverified');
      expect(f.calls).toEqual([]);
      expect(f.store.read('one')).toEqual(pending);
      expect(f.store.receipt(revision.requestId)).toBeNull();
      expect(f.privateStore.read(oldRef)).toEqual(previousSecret);
      if (nextRef !== null) expect(f.privateStore.read(nextRef)).toEqual(nextSecret);
      f.reopen();
      expect(f.store.read('one')).toEqual(pending);
    }
    // Even if private recovery completes, a failed receipt transaction retains both references.
    if (phase === 'publication') {
      f.db.exec(
        "CREATE TRIGGER reject_pending BEFORE INSERT ON ocean_model_connection_receipts WHEN NEW.request_id='pending' BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
      );
      expect(original).toThrow('receipt failure');
      f.reopen();
      expect(f.store.read('one')).toEqual(pending);
      expect(f.store.receipt('pending')).toBeNull();
    }
    f.db.exec('DROP TRIGGER reject_pending');
    const recovered = original();
    expect(recovered.revision).toBe(2);
    expect(f.privateStore.read(oldRef)).toEqual({ status: 'absent' });
    if (nextRef !== null)
      expect(f.privateStore.read(nextRef)).toEqual({ status: 'ok', key: 'second-synthetic-key' });
    expect(f.store.read('one')!.pendingSecretChange).toBeNull();
    f.reopen();
    f.calls.splice(0);
    expect(original()).toEqual(recovered);
    expect(f.calls).toEqual([]);
    expect(f.store.receipt('pending')!.publicResult!.status).toEqual(recovered);
  },
);

it.each([false, true])(
  'repairs null legacy intent (missing ref=%s) durably without claiming unidentified cleanup',
  (missingRef) => {
    const f = modelRecovery();
    f.service.set(input);
    const saved = f.store.read('one')!;
    const unknown = {
      ...saved,
      intent: 'pending' as const,
      secretRef: missingRef ? null : saved.secretRef,
      pendingSecretChange: null,
    };
    f.store.put(unknown, 1);
    f.db
      .prepare('DELETE FROM ocean_model_connection_receipts WHERE request_id=?')
      .run(input.requestId);
    const unidentified = 'psec_unknownhistoric';
    f.privateStore.write(unidentified, 'unidentified-synthetic-key');
    f.reopen();
    const revision = { connectionId: 'one', expectedRevision: 1 };
    const { key: _key, ...withoutKey } = input;
    for (const reject of [
      () => f.service.set(input),
      () => f.service.set({ ...withoutKey, requestId: 'model-only', expectedRevision: 1 }),
      () => f.service.disconnect({ ...revision, requestId: 'off' }),
      () => f.service.removeSavedKey({ ...revision, requestId: 'remove' }),
    ]) {
      f.calls.splice(0);
      expect(reject).toThrow('provider_unverified');
      expect(f.calls).toEqual([]);
      expect(f.store.read('one')).toEqual(unknown);
    }
    const repair = {
      ...input,
      requestId: 'repair',
      expectedRevision: 1,
      key: 'repair-synthetic-key',
    };
    f.controls.fail = missingRef ? 'write' : 'replace';
    expect(() => f.service.set(repair)).toThrow('provider_write_failed');
    const pending = f.store.read('one')!;
    expect(pending.pendingSecretChange).toEqual({
      action: 'replace',
      previousRef: unknown.secretRef,
      nextRef: pending.secretRef,
    });
    expect(f.privateStore.read(saved.secretRef!)).toEqual({ status: 'ok', key: input.key });
    f.reopen();
    f.controls.fail = null;
    for (const reject of [
      () => f.service.set({ ...repair, requestId: 'another', expectedRevision: 2 }),
      () => f.service.disconnect({ connectionId: 'one', requestId: 'off', expectedRevision: 2 }),
      () =>
        f.service.removeSavedKey({ connectionId: 'one', requestId: 'remove', expectedRevision: 2 }),
    ]) {
      f.calls.splice(0);
      expect(reject).toThrow('provider_unverified');
      expect(f.calls).toEqual([]);
      expect(f.store.read('one')).toEqual(pending);
    }
    const result = f.service.set(repair);
    expect(result).toMatchObject({ source: 'saved', revision: 2 });
    expect(f.privateStore.read(saved.secretRef!)).toEqual(
      missingRef ? { status: 'ok', key: input.key } : { status: 'absent' },
    );
    expect(f.privateStore.read(unidentified)).toEqual({
      status: 'ok',
      key: 'unidentified-synthetic-key',
    });
    expect(f.store.receipt(input.requestId)).toBeNull();
    f.reopen();
    f.calls.splice(0);
    expect(f.service.set(repair)).toEqual(result);
    expect(f.calls).toEqual([]);
  },
);
