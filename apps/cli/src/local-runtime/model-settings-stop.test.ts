import { afterEach, expect, it, vi } from 'vitest';
import { ModelConnectionService, RoomModelExecutionReads } from '@runnets/application';
import {
  privateRoot,
  startProviderHost,
  vendorFixture,
} from '../../test-fixtures/local-provider-host.test.js';
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});
async function fixture() {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  cleanups.push(
    () => profile.dispose(),
    () => vendor.close(),
  );
  const started = await startProviderHost(profile, { baseUrl: vendor.url });
  cleanups.push(() => started.stop());
  await started.client.setModelConnection({
    connectionId: 'named',
    requestId: 'set',
    expectedRevision: null,
    providerId: 'deepseek',
    kind: 'cloud',
    endpoint: 'https://api.deepseek.com',
    auth: 'api_key',
    defaultModelId: 'deepseek-flash',
    key: 'fixture-key',
  });
  return { vendor, profile, ...started };
}
it('joins a real in-flight model check before stop reports complete and closes mutation admission', async () => {
  const f = await fixture();
  f.vendor.holdModels();
  const check = f.client.checkModelConnection({ connectionId: 'named' });
  await vi.waitFor(() => expect(f.vendor.requests).toHaveLength(1));
  let stopped = false;
  const stop = f.host.stop().then((r) => {
    stopped = true;
    return r;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  await expect(
    f.client.disconnectModelConnection({
      connectionId: 'named',
      requestId: 'after',
      expectedRevision: 1,
    }),
  ).rejects.toThrow('runtime_draining');
  f.vendor.releaseModels();
  expect(await check).toMatchObject({ check: { outcome: 'ok', persisted: true } });
  expect(await stop).toMatchObject({ state: 'stopped', outcome: 'complete' });
});
it('keeps an async execution read registered after socket detach until its owner work settles', async () => {
  const f = await fixture();
  let settle!: () => void;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const read = vi.spyOn(RoomModelExecutionReads.prototype, 'get').mockImplementation(async () => {
    await gate;
    throw Error('unknown_run');
  });
  const response = f.client
    .getRunModelExecution({ workspaceId: 'ws_ocean', roomId: f.profile.roomId, runId: 'fixture' })
    .catch((e) => e);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  f.client.close();
  let stopped = false;
  const stop = f.host.stop().then((r) => {
    stopped = true;
    return r;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  settle();
  expect(await stop).toMatchObject({ outcome: 'complete' });
  await response;
});
it.each([
  null,
  {
    id: 'fixture',
    models: ['fixture'],
    capabilities: { usage: true, streaming: true, reasoning: false },
    async *stream() {
      yield* [];
    },
  },
])(
  'keeps injected/disabled mutation permission independent from model support',
  async (provider) => {
    const profile = await privateRoot();
    cleanups.push(() => profile.dispose());
    const started = await startProviderHost(profile, { baseUrl: '', provider });
    cleanups.push(() => started.stop());
    expect(started.client.identity.capabilities).toContain('model.connections-v1');
    await expect(
      started.client.setModelConnection({
        connectionId: 'c',
        requestId: 'r',
        expectedRevision: null,
        providerId: 'deepseek',
        kind: 'cloud',
        endpoint: 'https://api.deepseek.com',
        auth: 'api_key',
        defaultModelId: 'deepseek-flash',
        key: 'fixture',
      }),
    ).rejects.toThrow(provider === null ? 'provider_unavailable' : 'provider_injected');
  },
);
it('serves explicit model reads in maintenance while refusing model and binding mutations', async () => {
  const profile = await privateRoot();
  cleanups.push(() => profile.dispose());
  const started = await startProviderHost(profile, { baseUrl: '', restore: true });
  cleanups.push(() => started.stop());
  const page = await started.client.listModelConnections();
  expect(page.items[0]?.restriction).toBe('restore_restricted');
  await expect(
    started.client.getRoomModelPolicy({ workspaceId: 'ws_ocean', roomId: profile.roomId }),
  ).resolves.toMatchObject({ version: 1 });
  await expect(
    started.client.createBoundBot({
      workspaceId: 'ws_ocean',
      requestId: 'r',
      handle: 'new',
      name: 'New',
      role: 'Fixture',
      binding: { connectionId: 'legacy:deepseek', modelId: 'deepseek-flash' },
    }),
  ).rejects.toThrow('restore_restricted');
  const check = vi.spyOn(ModelConnectionService.prototype, 'check');
  await expect(
    started.client.checkModelConnection({ connectionId: 'legacy:deepseek' }),
  ).rejects.toThrow('restore_restricted');
  expect(check).not.toHaveBeenCalled();
});
