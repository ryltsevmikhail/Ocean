import { afterEach, expect, it, vi } from 'vitest';
import { modelSupport, refreshModelSettings } from './model-support.js';
afterEach(() => {
  vi.unstubAllGlobals();
  modelSupport.value = null;
});
const ok = (data: unknown) => ({ version: 1, ok: true, data });
it('uses negotiated metadata without invoking the legacy unverified status path or probes', async () => {
  const ops: string[] = [];
  vi.stubGlobal('window', {
    ocean: {
      request: async (c: { op: string }) => {
        ops.push(c.op);
        if (c.op === 'model-support') return ok({ connections: true });
        if (c.op === 'model-connections')
          return ok({ version: 1, workspaceId: 'ws_ocean', items: [], nextAfter: null });
        if (c.op === 'bound-bots')
          return ok({
            version: 1,
            workspaceId: 'ws_ocean',
            roomId: null,
            items: [],
            nextAfter: null,
          });
        if (c.op === 'model-presets') return ok([]);
        return { version: 1, ok: false, error: { code: 'provider_unverified' } };
      },
    },
  });
  await refreshModelSettings();
  expect(modelSupport.value).toBe(true);
  expect(ops.sort()).toEqual(['bound-bots', 'model-connections', 'model-presets', 'model-support']);
});
it('keeps the legacy form available on a safe old host without calling model RPCs', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(ok({ connections: false }))
    .mockResolvedValueOnce({ version: 1, ok: false, error: { code: 'provider_unavailable' } });
  vi.stubGlobal('window', { ocean: { request } });
  await refreshModelSettings();
  expect(modelSupport.value).toBe(false);
  expect(request.mock.calls.map((x) => x[0].op)).toEqual(['model-support', 'provider']);
});
it('never falls back after the unsafe pre-A3 host refusal', async () => {
  const request = vi.fn().mockResolvedValue({
    version: 1,
    ok: false,
    error: { code: 'plugin_runtime_upgrade_required' },
  });
  vi.stubGlobal('window', { ocean: { request } });
  await expect(refreshModelSettings()).rejects.toThrow('plugin_runtime_upgrade_required');
  expect(modelSupport.value).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});
