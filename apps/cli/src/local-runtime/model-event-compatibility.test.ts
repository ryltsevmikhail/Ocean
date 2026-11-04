import { afterEach, expect, it, vi } from 'vitest';
import {
  LOCAL_MODEL_METHODS,
  LOCAL_PLUGIN_SESSION_AUTHORITY,
  LOCAL_MODEL_CONNECTIONS,
} from '@runnets/contracts';
import { localRoomClient } from '../../test-fixtures/rc2-room-client.js';
import {
  privateRoot,
  startProviderHost,
  vendorFixture,
  completedRun,
} from '../../test-fixtures/local-provider-host.test.js';
import { modelWire } from '../../test-fixtures/local-model-wire.js';
import { isLocalRuntimeIdentity as rc2 } from '../../test-fixtures/rc2-runtime-contract.js';
import { ModelSettings } from './model-settings.js';
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});
it('preserves physical model-only pages and boundary cursors for concurrent RC2/A3/B sockets', async () => {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  cleanups.push(
    () => profile.dispose(),
    () => vendor.close(),
  );
  const started = await startProviderHost(profile, { baseUrl: vendor.url });
  cleanups.push(() => started.stop());
  const set = {
    connectionId: 'named',
    requestId: 'set',
    expectedRevision: null,
    providerId: 'deepseek',
    kind: 'cloud' as const,
    endpoint: 'https://api.deepseek.com',
    auth: 'api_key' as const,
    defaultModelId: 'deepseek-flash',
    key: 'fixture-key',
  };
  await started.client.setModelConnection(set);
  await started.client.setBotModelBinding({
    workspaceId: 'ws_ocean',
    botId: profile.botId,
    requestId: 'bind',
    expectedProfileVersion: 1,
    binding: { connectionId: 'named', modelId: 'deepseek-flash' },
  });
  const scope = { workspaceId: 'ws_ocean', roomId: profile.roomId };
  const receipt = await started.client.submit({ ...scope, requestId: 'turn', text: 'fixture' });
  await completedRun(started.client, profile, receipt.runId!);
  const old = await modelWire(profile.profile, []);
  const a3 = await modelWire(profile.profile, [LOCAL_PLUGIN_SESSION_AUTHORITY]);
  const current = await modelWire(profile.profile, [
    LOCAL_PLUGIN_SESSION_AUTHORITY,
    LOCAL_MODEL_CONNECTIONS,
  ]);
  cleanups.push(
    () => old.close(),
    () => a3.close(),
    () => current.close(),
  );
  const dispatch = vi.spyOn(ModelSettings.prototype, 'dispatch');
  for (const method of LOCAL_MODEL_METHODS) {
    await expect(old.send(method, {})).rejects.toThrow('model_runtime_upgrade_required');
    await expect(a3.send(method, {})).rejects.toThrow('model_runtime_upgrade_required');
  }
  expect(dispatch).not.toHaveBeenCalled();
  // Same frozen positional decoder used by RC2 (sequence === after + index + 1).
  const legacy = localRoomClient(old.send, old.identity);
  const query = { ...scope, runId: receipt.runId!, after: 4, limit: 2 };
  for (let i = 0; i < 3; i++) {
    expect(rc2(await old.status())).toBe(true);
    expect((await a3.status()).capabilities).toHaveLength(65);
    expect((await current.status()).capabilities).toHaveLength(66);
    const page = await legacy.listEvents(query);
    expect(page).toEqual([
      { sequence: 5, type: 'redacted', sensitivity: 'restricted' },
      { sequence: 6, type: 'redacted', sensitivity: 'restricted' },
    ]);
    const model = (await current.send('runs.events', query)) as {
      events: { type: string; sequence: number }[];
    };
    expect(model.events.map((x) => x.type)).toEqual([
      'attempt.model_request_started',
      'attempt.model_request_settled',
    ]);
    const boundary = await legacy.listEvents({ ...query, after: 5 });
    expect(boundary[0]).toEqual(page[1]);
    expect(boundary[1]).toMatchObject({ sequence: 7, type: 'attempt.usage_recorded' });
    const next = await legacy.listEvents({ ...query, after: page.at(-1)!.sequence });
    expect(next[0]?.sequence).toBe(7);
    await expect(old.send('plugin.catalog', {})).rejects.toThrow('plugin_runtime_upgrade_required');
    expect(Array.isArray(await a3.send('plugin.catalog', {}))).toBe(true);
    expect(await current.send('modelConnections.list', {})).toMatchObject({ version: 1 });
  }
  const observed = await started.client.observeRun({ ...scope, runId: receipt.runId! });
  expect(observed.snapshot.version).toBe(8);
});
