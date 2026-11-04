import { describe, expect, it } from 'vitest';
import { record } from '../test-fixtures/provider-connection-fakes.js';
import { fixture, set } from '../test-fixtures/provider-connection-service.js';

describe('provider connection service', () => {
  it('persists a saved key outside metadata and reports it without any key bytes', () => {
    const f = fixture();
    expect(f.service.status()).toMatchObject({
      source: 'none',
      state: 'absent',
      savedKey: false,
      revision: 0,
      writable: true,
    });
    const status = f.service.set(set);
    expect(status).toMatchObject({
      provider: 'deepseek',
      source: 'saved',
      state: 'connected',
      model: 'deepseek-flash',
      savedKey: true,
      revision: 1,
      code: null,
    });
    expect(status.models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(status.modelCapabilities).toEqual([
      { model: 'deepseek-flash', imageInput: true },
      { model: 'deepseek-v4-pro', imageInput: false },
    ]);
    expect([...f.secrets.values.values()]).toEqual(['sk-fixture-saved-key']);
    const durable = JSON.stringify([...f.store.rows.values(), ...f.store.receipts.values()]);
    expect(durable).not.toContain('sk-fixture-saved-key');
    expect(JSON.stringify(status)).not.toContain('sk-fixture-saved-key');
    expect(f.service.current()?.id).toBe('deepseek');
  });

  it('is idempotent by requestId and rejects a changed payload for the same requestId', () => {
    const f = fixture();
    const first = f.service.set(set);
    const replay = f.service.set(set);
    expect(replay).toEqual(first);
    expect(f.secrets.writes).toHaveLength(1);
    expect((f.service.current() as { key: string }).key).toBe(set.key);
    expect(() => f.service.set({ ...set, model: 'deepseek-v4-pro' })).toThrow('request_conflict');
    expect(() => f.service.set({ ...set, key: 'sk-different-key' })).toThrow('request_conflict');
    expect(f.service.status().revision).toBe(1);
    expect(f.store.rows.get('deepseek')?.secretRef).not.toBeNull();
  });

  it('replays the original receipt after a runtime restart without republishing', () => {
    const f = fixture();
    const first = f.service.set(set);
    const writes = f.secrets.writes.length;
    const restarted = f.restart();
    expect(restarted.set(set)).toEqual(first);
    expect(f.secrets.writes).toHaveLength(writes);
    expect(restarted.status()).toMatchObject({ source: 'saved', state: 'connected', revision: 1 });
  });

  it('replaces a saved key, activates the new snapshot and removes the old private value', () => {
    const f = fixture();
    f.service.set(set);
    const before = f.service.current();
    expect((before as { key: string }).key).toBe(set.key);
    const after = f.service.set({
      requestId: 'set-2',
      key: 'sk-fixture-rotated-key',
      model: 'deepseek-v4-pro',
    });
    expect(after).toMatchObject({ source: 'saved', state: 'connected', revision: 2 });
    expect(f.secrets.values.size).toBe(1);
    expect([...f.secrets.values.values()]).toEqual(['sk-fixture-rotated-key']);
    const rotated = f.service.current();
    expect(rotated).not.toBe(before);
    expect((rotated as { key: string }).key).toBe('sk-fixture-rotated-key');
    expect(f.service.status().model).toBe('deepseek-v4-pro');
  });

  it('validates the model against the adapter and fails closed on an unknown persisted model', () => {
    const f = fixture();
    expect(() => f.service.set({ ...set, model: 'deepseek-chat' })).toThrow(
      'provider_invalid_model',
    );
    f.seed(record({ secretRef: 'psec_old', model: 'deepseek-chat' }), 'sk-fixture-saved-key');
    expect(f.restart().status()).toMatchObject({
      state: 'invalid_model',
      code: 'provider_invalid_model',
      model: 'deepseek-chat',
    });
    expect(f.service.current()).toBeNull();
    const fixed = f.service.set({ requestId: 'set-fix', model: 'deepseek-v4-pro' });
    expect(fixed).toMatchObject({ state: 'connected', model: 'deepseek-v4-pro', revision: 2 });
    expect(f.secrets.writes).toHaveLength(0);
  });

  it('records a bounded check result and persists only metadata', async () => {
    const f = fixture();
    f.service.set(set);
    const result = await f.service.check();
    expect(result.check).toMatchObject({
      outcome: 'ok',
      httpStatus: 200,
      modelSupported: true,
      source: 'saved',
      revision: 1,
      persisted: true,
    });
    expect(result.check.models).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(result.status.lastCheck).toMatchObject({ outcome: 'ok', revision: 1 });
    expect(f.credentials.probes).toHaveLength(1);
    expect(f.credentials.probes[0]?.key).toBe('sk-fixture-saved-key');
    expect(f.credentials.probes[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(f.store.rows.get('deepseek'))).not.toContain('sk-fixture-saved-key');
    expect(result.check.durationMs).toBeGreaterThanOrEqual(0);
    // Bounded check metadata is durable, so a restart keeps the last honest result.
    expect(f.restart().status().lastCheck).toMatchObject({ outcome: 'ok', revision: 1 });
  });

  it('normalizes a failed check without vendor text and never leaks the key', async () => {
    const f = fixture();
    f.service.set(set);
    f.credentials.probe = async () => ({ outcome: 'auth', httpStatus: 401, models: [] });
    const result = await f.service.check();
    expect(result.check).toMatchObject({ outcome: 'auth', httpStatus: 401, persisted: true });
    expect(JSON.stringify(result)).not.toContain('sk-fixture-saved-key');
  });

  it('does not let a stale check overwrite a newer configuration', async () => {
    const f = fixture();
    f.service.set(set);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured!: () => void;
    f.credentials.probe = async () => {
      captured();
      await gate;
      return { outcome: 'ok', httpStatus: 200, models: ['deepseek-flash'] };
    };
    const entered = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const pending = f.service.check();
    await entered;
    f.service.set({ requestId: 'set-2', model: 'deepseek-v4-pro' });
    release();
    const result = await pending;
    expect(result.check.persisted).toBe(false);
    expect(f.store.rows.get('deepseek')?.revision).toBe(2);
    expect(f.store.rows.get('deepseek')?.lastCheck).toBeNull();
    expect(result.status.revision).toBe(2);
  });

  it('keeps last check metadata across a key rotation but not the old key', async () => {
    const f = fixture();
    f.service.set(set);
    await f.service.check();
    f.advance(1000);
    f.service.set({ requestId: 'set-2', key: 'sk-fixture-next-key', model: 'deepseek-flash' });
    const status = f.service.status();
    expect(status.lastCheck?.outcome).toBe('ok');
    expect(status.revision).toBe(2);
    expect(JSON.stringify(status)).not.toContain('sk-fixture-next-key');
  });
});

describe('atomic saved-key replacement', () => {
  it('rotates the private value in one atomic publication instead of a separate purge', () => {
    const f = fixture();
    f.service.set(set);
    // A surviving remove failure proves rotation never depends on a second effect.
    f.secrets.removeFailure = Error('remove unavailable');
    const rotated = f.service.set({
      requestId: 'set-2',
      key: 'sk-fixture-rotated-key',
      model: 'deepseek-flash',
    });
    expect(rotated).toMatchObject({ source: 'saved', state: 'connected', revision: 2 });
    expect(f.secrets.replaces).toHaveLength(1);
    expect(f.secrets.replaces[0]?.previous).toMatch(/^psec_/);
    expect(f.secrets.replaces[0]?.ref).toMatch(/^psec_/);
    expect(f.secrets.values.size).toBe(1);
    expect([...f.secrets.values.values()]).toEqual(['sk-fixture-rotated-key']);
  });

  it('keeps the old value and fails closed when the replacement cannot be published', () => {
    const f = fixture();
    f.service.set(set);
    const previousRef = f.store.rows.get('deepseek')?.secretRef;
    f.secrets.replaceFailure = Error('fsync failed');
    expect(() =>
      f.service.set({ requestId: 'set-2', key: 'sk-fixture-next-key', model: 'deepseek-flash' }),
    ).toThrow('provider_write_failed');
    // Nothing was published: the old private value is untouched and no new bytes exist.
    expect([...f.secrets.values.values()]).toEqual([set.key]);
    expect(f.secrets.values.has(previousRef!)).toBe(true);
    // The persisted intent fails closed until an explicit owner retry.
    expect(f.service.status()).toMatchObject({
      source: 'none',
      state: 'unverified',
      savedKey: true,
      revision: 2,
    });
    expect(f.service.current()).toBeNull();
  });
});
