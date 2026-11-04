import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { commands, outputs, type ProviderStatus } from '../protocol.js';
import {
  checkProvider,
  disconnectProvider,
  loadProviderStatus,
  providerBusy,
  providerCanSave,
  providerError,
  providerKey,
  providerMessage,
  providerModel,
  providerModels,
  providerStatus,
  removeSavedProviderKey,
  requireProviderDefaultModel,
  resetProviderState,
  saveProvider,
  clearProviderInput,
} from './provider-state.js';

const status: ProviderStatus = {
  provider: 'deepseek',
  source: 'saved',
  state: 'connected',
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  modelCapabilities: [
    { model: 'deepseek-flash', imageInput: true },
    { model: 'deepseek-v4-pro', imageInput: false },
  ],
  revision: 2,
  savedKey: true,
  writable: true,
  code: null,
  lastCheck: null,
};
type Reply =
  { version: 1; ok: true; data: unknown } | { version: 1; ok: false; error: { code: string } };
const ok = (data: unknown): Reply => ({ version: 1, ok: true, data });
const fail = (code: string): Reply => ({ version: 1, ok: false, error: { code } });
function channel(replies: Reply[]) {
  const request = vi.fn<(message: unknown) => Promise<unknown>>();
  for (const reply of replies) request.mockResolvedValueOnce(reply);
  vi.stubGlobal('window', { ocean: { request } });
  return request;
}
beforeEach(() => resetProviderState());
afterEach(() => {
  vi.unstubAllGlobals();
  resetProviderState();
});

it('loads real status metadata and never stores the key in state', async () => {
  const request = channel([ok(status)]);
  await loadProviderStatus();
  expect(request).toHaveBeenCalledWith({ op: 'provider' });
  expect(providerStatus.value).toEqual(status);
  expect(providerModel.value).toBe('deepseek-flash');
  expect(providerModels.value).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  expect(JSON.stringify(providerStatus.value)).not.toContain('sk-');
  expect(providerKey.value).toBe('');
  expect(providerBusy.value).toBe(false);
});

it('saves the transient key, clears it after submission and applies the returned status', async () => {
  const request = channel([ok({ ...status, savedKey: false, revision: 0 }), ok(status)]);
  await loadProviderStatus();
  providerKey.value = 'sk-fixture-ui-key';
  expect(providerCanSave.value).toBe(true);
  await saveProvider();
  const sent = request.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(sent).toMatchObject({
    op: 'provider-set',
    key: 'sk-fixture-ui-key',
    model: 'deepseek-flash',
  });
  expect(commands.safeParse(sent).success).toBe(true);
  expect(typeof sent['requestId']).toBe('string');
  expect(providerKey.value).toBe('');
  expect(providerStatus.value).toEqual(status);
  expect(JSON.stringify(providerStatus.value)).not.toContain('sk-fixture-ui-key');
});

it('clears the transient key after a refused submission and shows a masked error', async () => {
  const request = channel([ok(status), fail('provider_auth')]);
  await loadProviderStatus();
  providerKey.value = 'sk-fixture-ui-key';
  await saveProvider();
  expect(providerKey.value).toBe('');
  expect(providerError.value).toBe(true);
  expect(JSON.stringify(providerStatus.value)).not.toContain('sk-fixture-ui-key');
  expect(request).toHaveBeenCalledTimes(2);

  channel([fail('request_conflict')]);
  providerKey.value = 'sk-fixture-ui-key';
  await saveProvider();
  expect(providerKey.value).toBe('');
  expect(providerError.value).toBe(true);
});

it('applies a model-only change when a saved key already exists', async () => {
  const request = channel([ok(status)]);
  await loadProviderStatus();
  providerKey.value = '';
  expect(providerCanSave.value).toBe(true);
  providerModel.value = 'deepseek-v4-pro';
  await saveProvider();
  const sent = request.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(sent).toMatchObject({ op: 'provider-set', model: 'deepseek-v4-pro' });
  expect(Object.hasOwn(sent, 'key')).toBe(false);
});

it('blocks a model-only save while the saved key is unverified', async () => {
  const unverified = {
    ...status,
    source: 'none' as const,
    state: 'unverified' as const,
    code: 'provider_secret_corrupt',
  };
  const request = channel([ok(unverified)]);
  await loadProviderStatus();
  providerKey.value = '';
  expect(providerCanSave.value).toBe(false);
  await saveProvider();
  expect(request).toHaveBeenCalledTimes(1);
  expect(providerError.value).toBe(true);
  expect(providerMessage.value).toContain('не удалось подтвердить');
  // Supplying a new key is still the explicit owner path back to a verified connection.
  providerKey.value = 'sk-fixture-ui-key';
  expect(providerCanSave.value).toBe(true);
});

it('refuses to save without a key or saved value and never calls the runtime', async () => {
  const missing = { ...status, source: 'none', state: 'absent', savedKey: false, revision: 0 };
  const request = channel([ok(missing)]);
  await loadProviderStatus();
  providerKey.value = '   ';
  expect(providerCanSave.value).toBe(false);
  await saveProvider();
  expect(request).toHaveBeenCalledTimes(1);
  expect(providerError.value).toBe(true);
});

it('checks the connection and reports a persisted normalized outcome', async () => {
  const request = channel([
    ok(status),
    ok({
      status: { ...status, lastCheck: checkMetadata() },
      check: { ...checkMetadata(), persisted: true },
    }),
  ]);
  await loadProviderStatus();
  await checkProvider();
  expect(request.mock.calls.at(-1)?.[0]).toEqual({ op: 'provider-check' });
  expect(providerMessage.value).toContain('Список моделей получен');
  expect(providerError.value).toBe(false);
  const statusReply = outputs['provider-check'].safeParse({
    status: { ...status, lastCheck: checkMetadata() },
    check: { ...checkMetadata(), persisted: true },
  });
  expect(statusReply.success).toBe(true);
});

it('accepts a cancelled check outcome from the runtime', () => {
  const cancelled = {
    ...checkMetadata(),
    outcome: 'cancelled' as const,
    httpStatus: null,
    revision: 3,
  };
  expect(
    outputs['provider-check'].safeParse({
      status: { ...status, lastCheck: cancelled },
      check: { ...cancelled, persisted: true },
    }).success,
  ).toBe(true);
});

it('surfaces a stale check honestly and never claims it was saved', async () => {
  channel([
    ok(status),
    ok({
      status: { ...status, revision: 3 },
      check: { ...checkMetadata(), persisted: false },
    }),
  ]);
  await loadProviderStatus();
  await checkProvider();
  expect(providerMessage.value).toContain('результат не сохранён');
});

it('sends guarded disconnect and saved-key deletion with the displayed revision', async () => {
  const disconnected = { ...status, source: 'none', state: 'disconnected', revision: 3 };
  const request = channel([ok(status), ok(disconnected), ok({ ...disconnected, revision: 4 })]);
  await loadProviderStatus();
  await disconnectProvider();
  const blocked = request.mock.calls[1]?.[0] as Record<string, unknown>;
  expect(blocked).toMatchObject({ op: 'provider-disconnect', expectedRevision: 2 });
  expect(typeof blocked['requestId']).toBe('string');
  expect(providerMessage.value).toContain('не отозван');
  await removeSavedProviderKey();
  expect(request.mock.calls[2]?.[0]).toMatchObject({
    op: 'provider-remove-key',
    expectedRevision: 3,
  });
  expect(commands.safeParse(request.mock.calls[2]?.[0]).success).toBe(true);
});

it('clears a typed but unsubmitted key when the settings dialog closes', async () => {
  channel([ok(status)]);
  await loadProviderStatus();
  providerKey.value = 'sk-fixture-unsubmitted';
  clearProviderInput();
  expect(providerKey.value).toBe('');
  expect(JSON.stringify(providerStatus.value)).not.toContain('sk-fixture-unsubmitted');
});

it('refuses to build the team without a loaded provider model', async () => {
  expect(() => requireProviderDefaultModel()).toThrow('provider_unavailable');
  channel([ok(status)]);
  await loadProviderStatus();
  expect(requireProviderDefaultModel()).toBe('deepseek-flash');
});

it('disables owner mutations on a read-only provider host', async () => {
  channel([ok({ ...status, writable: false, state: 'restored', source: 'none' })]);
  await loadProviderStatus();
  providerKey.value = 'sk-fixture-ui-key';
  expect(providerCanSave.value).toBe(false);
  await disconnectProvider();
  await removeSavedProviderKey();
});

function checkMetadata() {
  return {
    outcome: 'ok' as const,
    httpStatus: 200,
    durationMs: 11,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    modelSupported: true,
    source: 'saved' as const,
    revision: 2,
    checkedAt: '2026-11-04T00:00:00.000Z',
  };
}
