import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as state from './provider-state.js';
const status = {
  provider: 'deepseek',
  source: 'saved',
  state: 'connected',
  model: 'deepseek-flash',
  models: ['deepseek-flash'],
  modelCapabilities: [{ model: 'deepseek-flash', imageInput: true }],
  revision: 2,
  savedKey: true,
  writable: true,
  code: null,
  lastCheck: null,
};
const ok = (data: unknown) => ({ version: 1, ok: true, data });
beforeEach(() => state.resetProviderState());
afterEach(() => {
  state.resetProviderState();
  vi.unstubAllGlobals();
});
it('retains an exact legacy original after loss, blocks a fresh UUID and explicitly resupplies raw bytes', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(ok(status))
    .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'connection_closed' } })
    .mockResolvedValueOnce(ok({ ...status, revision: 4 }))
    .mockResolvedValueOnce(ok({ ...status, revision: 3 }))
    .mockResolvedValueOnce(ok({ ...status, revision: 5 }));
  vi.stubGlobal('window', { ocean: { request } });
  await state.loadProviderStatus();
  state.providerKey.value = '  raw-key  ';
  const saving = state.saveProvider();
  expect(state.providerKey.value).toBe('');
  await saving;
  const original = request.mock.calls.find((x) => x[0].op === 'provider-set')?.[0];
  state.providerKey.value = 'different';
  await state.saveProvider();
  expect(request.mock.calls.filter((x) => x[0].op === 'provider-set')).toHaveLength(1);
  state.providerKey.value = '  raw-key  ';
  await state.recoverProvider();
  expect(request.mock.calls.filter((x) => x[0].op === 'provider-set').map((x) => x[0])).toEqual([
    original,
    original,
  ]);
  expect(state.providerStatus.value?.revision).toBe(5);
  expect(state.providerPending.value).toBeNull();
  expect(original).not.toHaveProperty('expectedRevision');
});
it.each(['provider-disconnect', 'provider-remove-key'] as const)(
  'retains exact revision and clears typed keys for unknown %s',
  async (op) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(ok(status))
      .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'runtime_timeout' } })
      .mockResolvedValueOnce(ok({ ...status, revision: 9 }))
      .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'revision_conflict' } })
      .mockResolvedValueOnce(ok({ ...status, revision: 9 }));
    vi.stubGlobal('window', { ocean: { request } });
    await state.loadProviderStatus();
    state.providerKey.value = 'unused';
    await (op === 'provider-disconnect'
      ? state.disconnectProvider()
      : state.removeSavedProviderKey());
    expect(state.providerKey.value).toBe('');
    const original = request.mock.calls.find((x) => x[0].op === op)?.[0];
    await state.recoverProvider();
    expect(request.mock.calls.filter((x) => x[0].op === op).map((x) => x[0])).toEqual([
      original,
      original,
    ]);
    expect(state.providerPending.value).not.toBeNull();
    expect(request.mock.calls.map((x) => x[0].op)).not.toContain('model-connections');
  },
);
it('clears the legacy key on model selection and Check submission', async () => {
  state.providerKey.value = 'unused';
  state.providerModel.value = 'changed';
  expect(state.providerKey.value).toBe('');
  const request = vi
    .fn()
    .mockResolvedValue({ version: 1, ok: false, error: { code: 'provider_unavailable' } });
  vi.stubGlobal('window', { ocean: { request } });
  state.providerKey.value = 'unused';
  const checking = state.checkProvider();
  expect(state.providerKey.value).toBe('');
  await checking;
});

it('keeps an unknown set after wrong-key/request conflict and contains no secret in its descriptor', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(ok(status))
    .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'outcome_unknown' } })
    .mockResolvedValueOnce(ok(status))
    .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'request_conflict' } })
    .mockResolvedValueOnce(ok(status));
  vi.stubGlobal('window', { ocean: { request } });
  await state.loadProviderStatus();
  state.providerKey.value = 'original-secret';
  await state.saveProvider();
  const original = state.providerPending.value;
  state.providerKey.value = 'wrong-secret';
  await state.recoverProvider();
  expect(state.providerPending.value).toEqual(original);
  expect(JSON.stringify(state.providerPending.value)).not.toContain('secret');
  await state.saveProvider();
  expect(request.mock.calls.filter((x) => x[0].op === 'provider-set')).toHaveLength(2);
});

it('keeps the retained old-host original authoritative for that connection after UI negotiation changes', async () => {
  const { createConnectionSettings } = await import('./model-connection-state.js');
  const { metadata, page } = await import('../../test-fixtures/model-settings.js');
  const request = vi
    .fn()
    .mockResolvedValueOnce(ok(status))
    .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'connection_closed' } })
    .mockResolvedValueOnce(ok(status));
  vi.stubGlobal('window', { ocean: { request } });
  await state.loadProviderStatus();
  state.providerKey.value = 'original';
  await state.saveProvider();
  const modelRequest = vi
    .fn()
    .mockResolvedValueOnce(
      page([
        {
          ...metadata('legacy:deepseek'),
          providerId: 'deepseek',
          kind: 'cloud',
          endpoint: 'https://api.deepseek.com',
          auth: 'api_key',
          defaultModelId: 'deepseek-flash',
        },
      ]),
    )
    .mockResolvedValueOnce([]);
  const s = createConnectionSettings(modelRequest);
  await s.load();
  s.select('legacy:deepseek');
  expect(s.canEdit.value).toBe(false);
  await s.save();
  expect(modelRequest).toHaveBeenCalledTimes(2);
});
