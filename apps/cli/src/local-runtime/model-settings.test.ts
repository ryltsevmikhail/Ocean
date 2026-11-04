import { afterEach, expect, it, vi } from 'vitest';
import { openOceanProfile } from '../ocean/profile.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import {
  ProviderActivationService,
  ModelConnectionService,
  RoomModelExecutionReads,
} from '@runnets/application';
import {
  privateRoot,
  startProviderHost,
  vendorFixture,
  completedRun,
} from '../../test-fixtures/local-provider-host.test.js';
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(ineligible = false) {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  cleanups.push(() => {
    profile.dispose();
  });
  cleanups.push(() => vendor.close());
  if (ineligible) {
    const runtime = openOceanProfile(profile.profile, false);
    await runtime.ready;
    const connections = runtime.providerConnections!.connections;
    const row = connections.read('legacy:deepseek')!;
    connections.put({ ...row, legacyEnvironment: false }, row.revision);
    runtime.close();
  }
  const started = await startProviderHost(profile, { baseUrl: vendor.url });
  cleanups.push(() => started.stop());
  const other = await connectLocalRuntime({ profile: profile.profile });
  cleanups.push(() => other.close());
  const scope = { workspaceId: 'ws_ocean', roomId: profile.roomId };
  const set = {
    connectionId: 'named',
    requestId: 'named-set',
    expectedRevision: null,
    providerId: 'deepseek',
    kind: 'cloud' as const,
    endpoint: 'https://api.deepseek.com',
    auth: 'api_key' as const,
    defaultModelId: 'deepseek-flash',
    key: 'synthetic-named-key',
  };
  return { vendor, profile, ...started, other, scope, set };
}
it('shares canonical settings, binding and policy snapshots across two authenticated clients without activating reads', async () => {
  const f = await fixture();
  const setCall = vi.spyOn(ModelConnectionService.prototype, 'set');
  const saved = await f.client.setModelConnection(f.set);
  const service = setCall.mock.contexts[0] as ModelConnectionService;
  const activateCredential = vi.spyOn(service.options.factory, 'activate');
  const externalCredential = vi.spyOn(service.options.factory, 'external');
  const secretRead = vi.spyOn(service.options.secrets, 'read');
  expect(saved).toMatchObject({ connectionId: 'named', revision: 1, source: 'saved' });
  const bound = await f.client.createBoundBot({
    workspaceId: 'ws_ocean',
    requestId: 'create-bound',
    handle: 'bound',
    name: 'Bound',
    role: 'Fixture',
    binding: { connectionId: 'named', modelId: 'deepseek-flash' },
  });
  const changed = await f.other.setBotModelBinding({
    workspaceId: 'ws_ocean',
    requestId: 'bind-original',
    botId: f.profile.botId,
    expectedProfileVersion: 1,
    binding: bound.binding!,
  });
  expect(changed.bot.profileVersion).toBe(2);
  const activate = vi.spyOn(ProviderActivationService.prototype, 'resolve');
  const check = vi.spyOn(ModelConnectionService.prototype, 'check');
  const beforeRequests = f.vendor.requests.length;
  const page = await f.other.listModelConnections({ workspaceId: 'ws_ocean', limit: 1 });
  expect(page.items[0]?.connectionId).toBe('legacy:deepseek');
  const nextPage = await f.other.listModelConnections({
    workspaceId: 'ws_ocean',
    after: page.nextAfter!,
    limit: 1,
  });
  expect(nextPage.items[0]?.connectionId).toBe('named');
  expect(nextPage.items[0]).toMatchObject({
    configuration: { intent: 'active', savedKeyReferencePresent: true },
    recovery: null,
  });
  const bots = await f.other.listBoundBots(f.scope);
  expect(bots.items).toContainEqual(changed);
  const policy = await f.other.getRoomModelPolicy(f.scope);
  const next = await f.client.setRoomModelPolicy({
    ...f.scope,
    requestId: 'policy',
    expectedRevision: policy.policy.revision,
    cloudTransfer: 'allow',
  });
  expect((await f.other.getRoomModelPolicy(f.scope)).policy).toEqual(next);
  expect(activateCredential).not.toHaveBeenCalled();
  expect(externalCredential).not.toHaveBeenCalled();
  expect(secretRead).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
  expect(f.vendor.requests).toHaveLength(beforeRequests);
  await expect(f.client.listModelConnections({ workspaceId: 'wrong' })).rejects.toThrow(
    'workspace_conflict',
  );
  await expect(f.client.getRoomModelPolicy({ ...f.scope, roomId: 'wrong' })).rejects.toThrow(
    'unknown_room',
  );
  await expect(f.client.getRunModelExecution({ ...f.scope, runId: 'wrong' })).rejects.toThrow(
    'unknown_run',
  );
});
it('transports the accepted single scoped execution projection and exact binding used for admission', async () => {
  const f = await fixture();
  await f.client.setModelConnection(f.set);
  await f.client.setBotModelBinding({
    workspaceId: 'ws_ocean',
    requestId: 'bind',
    botId: f.profile.botId,
    expectedProfileVersion: 1,
    binding: { connectionId: 'named', modelId: 'deepseek-flash' },
  });
  const turn = await f.client.submit({ ...f.scope, requestId: 'turn', text: 'fixture' });
  await completedRun(f.client, f.profile, turn.runId!);
  const read = vi.spyOn(RoomModelExecutionReads.prototype, 'get');
  const query = { ...f.scope, runId: turn.runId! };
  const result = await f.other.getRunModelExecution(query);
  expect(read).toHaveBeenCalledExactlyOnceWith(query);
  expect(result.execution?.identity).toMatchObject({
    source: 'connection',
    connectionId: 'named',
    connectionRevision: 1,
    botProfileVersion: 2,
  });
  expect(result.execution?.usage.requestCounts).toEqual({
    actual: 1,
    estimated: 0,
    unavailable: 0,
    pending: 0,
  });
  expect(JSON.stringify(result)).not.toContain('synthetic-named-key');
});
it('returns the known sanitized legacy status refusal for a canonical legacy-ineligible connection', async () => {
  const f = await fixture(true);
  await f.client.setModelConnection({
    ...f.set,
    connectionId: 'legacy:deepseek',
    requestId: 'default-set',
    expectedRevision: 0,
  });
  await expect(f.other.providerStatus()).rejects.toThrow('provider_unverified');
  expect(f.vendor.requests).toHaveLength(0);
  expect(
    (await f.other.listModelConnections()).items.some((x) => x.connectionId === 'legacy:deepseek'),
  ).toBe(true);
});
