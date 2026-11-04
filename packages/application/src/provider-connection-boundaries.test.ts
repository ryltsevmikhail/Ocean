import { describe, expect, it } from 'vitest';
import { disconnect, fixture, remove, set } from '../test-fixtures/provider-connection-service.js';

describe('provider connection boundaries', () => {
  it('persists an explicit disconnect above a retained secret and the environment', () => {
    const f = fixture({ environment: true });
    f.service.set(set);
    const blocked = f.service.disconnect(disconnect);
    expect(blocked).toMatchObject({
      source: 'none',
      state: 'disconnected',
      code: 'provider_disconnected',
      savedKey: true,
      revision: 2,
    });
    expect(f.service.current()).toBeNull();
    // Restart must not resurrect either the retained saved key or the environment value.
    expect(f.restart().status()).toMatchObject({ state: 'disconnected', source: 'none' });
    expect(f.service.current()).toBeNull();
    expect(f.secrets.values.size).toBe(1);
  });

  it('re-enables the environment only through an explicit set or saved-key removal', () => {
    const f = fixture({ environment: true });
    f.service.set(set);
    f.service.disconnect(disconnect);
    const reopened = f.service.set({ requestId: 'set-reopen', model: 'deepseek-flash' });
    expect(reopened).toMatchObject({ source: 'saved', state: 'connected', revision: 3 });
    f.service.disconnect({ requestId: 'disconnect-2', expectedRevision: 3 });
    const removed = f.service.removeSavedKey({ requestId: 'remove-1', expectedRevision: 4 });
    expect(removed).toMatchObject({
      source: 'external',
      state: 'connected',
      savedKey: false,
      revision: 5,
    });
    expect(f.service.current()?.id).toBe('deepseek');
    expect(f.secrets.values.size).toBe(0);
  });

  it('deletes only the Ocean-managed value and reports absence truthfully', () => {
    const f = fixture();
    f.service.set(set);
    const removed = f.service.removeSavedKey({ requestId: 'remove-1', expectedRevision: 1 });
    expect(removed).toMatchObject({
      source: 'none',
      state: 'absent',
      savedKey: false,
      revision: 2,
      model: 'deepseek-flash',
    });
    expect(f.secrets.values.size).toBe(0);
    expect(f.service.current()).toBeNull();
  });

  it('rejects stale revision mutations without overwriting a newer configuration', () => {
    const f = fixture();
    f.service.set(set);
    expect(() => f.service.disconnect({ requestId: 'stale', expectedRevision: 0 })).toThrow(
      'revision_conflict',
    );
    expect(() => f.service.removeSavedKey({ requestId: 'stale-2', expectedRevision: 7 })).toThrow(
      'revision_conflict',
    );
    expect(f.service.status().revision).toBe(1);
    expect(f.secrets.values.size).toBe(1);
    expect(() => f.service.disconnect(disconnect)).not.toThrow();
    expect(() => f.service.disconnect(disconnect)).not.toThrow();
  });

  it('fails closed after an interrupted publication and never falls back to the environment', () => {
    const f = fixture({ environment: true });
    f.secrets.writeFailure = Error('insecure_permissions');
    expect(() => f.service.set(set)).toThrow('insecure_permissions');
    const status = f.service.status();
    expect(status).toMatchObject({
      source: 'none',
      state: 'unverified',
      code: 'provider_unverified',
      savedKey: true,
      revision: 1,
    });
    expect(status.lastCheck).toBeNull();
    expect(f.service.current()).toBeNull();
    // A restart keeps the conservative state; only an explicit owner request resolves it.
    expect(f.restart().status()).toMatchObject({ state: 'unverified', source: 'none' });
    expect(f.service.current()).toBeNull();
    f.secrets.writeFailure = null;
    const resumed = f.service.set(set);
    expect(resumed).toMatchObject({ source: 'saved', state: 'connected', revision: 1 });
    expect((f.service.current() as { key: string }).key).toBe(set.key);
    expect(f.secrets.writes).toHaveLength(1);
  });

  it('fails closed when a saved secret disappeared, even with an environment value', () => {
    const f = fixture({ environment: true });
    f.service.set(set);
    f.secrets.values.clear();
    expect(f.restart().status()).toMatchObject({
      source: 'none',
      state: 'unverified',
      code: 'provider_unverified',
      savedKey: true,
    });
    expect(f.service.current()).toBeNull();
  });

  it('reports a corrupt private store as unverified rather than connected', () => {
    const f = fixture();
    f.service.set(set);
    f.secrets.readOverride = () => ({ status: 'unverified', reason: 'provider_secret_corrupt' });
    expect(f.restart().status()).toMatchObject({
      state: 'unverified',
      code: 'provider_secret_corrupt',
    });
    expect(f.service.current()).toBeNull();
  });

  it('keeps a restored profile inert when the saved key is explicitly deleted', () => {
    const f = fixture({ restored: true, environment: true });
    f.seed(
      {
        provider: 'deepseek',
        model: 'deepseek-flash',
        secretRef: 'psec_restored',
        intent: 'active',
        revision: 5,
        requestId: 'before-restore',
        binding: 'before',
        lastCheck: null,
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
      'sk-fixture-saved-key',
    );
    f.restart();
    expect(f.service.status()).toMatchObject({ state: 'restored', savedKey: true, revision: 5 });
    const removed = f.service.removeSavedKey({ requestId: 'remove-restored', expectedRevision: 5 });
    expect(removed).toMatchObject({
      source: 'none',
      state: 'restored',
      savedKey: false,
      revision: 6,
    });
    expect(f.service.current()).toBeNull();
    expect(f.secrets.values.size).toBe(0);
  });
  it('refuses owner mutations on a restore-mode maintenance host', () => {
    const f = fixture({ restored: true, mutationsAllowed: false });
    expect(f.service.status()).toMatchObject({ state: 'restored', writable: false });
    expect(() => f.service.set(set)).toThrow('restore_restricted');
    expect(() => f.service.disconnect(disconnect)).toThrow('restore_restricted');
    expect(() => f.service.removeSavedKey(remove)).toThrow('restore_restricted');
    expect(f.secrets.values.size).toBe(0);
  });

  it('refuses a model-only change when the saved secret cannot be read', () => {
    const f = fixture({ environment: true });
    f.service.set(set);
    const activations = f.credentials.bound.length;
    f.secrets.readOverride = () => ({ status: 'unverified', reason: 'provider_secret_corrupt' });
    expect(() => f.service.set({ requestId: 'set-model', model: 'deepseek-v4-pro' })).toThrow(
      'provider_unverified',
    );
    // The saved reference is never dropped in favour of the environment credential.
    expect(f.store.rows.get('deepseek')?.secretRef).not.toBeNull();
    expect(f.service.status()).toMatchObject({
      source: 'none',
      state: 'unverified',
      code: 'provider_secret_corrupt',
      savedKey: true,
      revision: 1,
    });
    expect(f.service.current()).toBeNull();
    expect(f.credentials.bound).toHaveLength(activations);
    f.secrets.readOverride = () => ({ status: 'absent' });
    expect(() => f.service.set({ requestId: 'set-model-2', model: 'deepseek-flash' })).toThrow(
      'provider_unverified',
    );
    expect(f.service.status()).toMatchObject({ state: 'unverified', savedKey: true });
  });

  it('keeps an explicit host force-off above an ambient environment credential', () => {
    const f = fixture({ environment: true, disabled: true });
    expect(f.service.status()).toMatchObject({
      source: 'none',
      state: 'absent',
      model: 'deepseek-flash',
      code: null,
      writable: false,
    });
    expect(f.service.current()).toBeNull();
    expect(f.service.activation()()).toBeNull();
    expect(() => f.service.set(set)).toThrow('provider_unavailable');
    expect(f.credentials.probes).toHaveLength(0);
  });

  it('surfaces a failed check without a network effect when no credential is active', async () => {
    const f = fixture();
    const result = await f.service.check();
    expect(result.check).toMatchObject({ outcome: 'unavailable', persisted: false });
    expect(result.status.lastCheck).toBeNull();
    expect(f.credentials.probes).toHaveLength(0);
  });
});
