import { afterEach, expect, it } from 'vitest';
import { privateRoot } from '../../test-fixtures/local-provider-host.test.js';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import { startLocalRuntime } from './host.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
it('owner socket writes durable connection receipts and rejects stale or changed requests', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  const host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  const peer = await serviceOwnerPeer(f.profile);
  cleanup.push(() => peer.close());
  const request = {
    requestId: 'set',
    connectionId: 'synthetic',
    expectedVersions: null,
    name: 'Synthetic',
    configuration: { kind: 'http', url: 'http://127.0.0.1:1/mcp' },
    metadataPermission: 'none',
  };
  const first = await peer.request('service.connection-set', request);
  expect(first).toMatchObject({
    state: 'completed',
    result: { id: 'synthetic', configRevision: 1 },
  });
  expect(await peer.request('service.connection-set', request)).toEqual(first);
  await expect(
    peer.request('service.connection-set', { ...request, name: 'changed' }),
  ).rejects.toThrow('request_conflict');
  expect(await peer.request('service.receipt', { requestId: 'set' })).toEqual(first);
  expect(await peer.request('service.connections', {})).toMatchObject([
    { id: 'synthetic', name: 'Synthetic' },
  ]);
  await expect(
    peer.request('service.connection-set', { ...request, requestId: 'stale' }),
  ).rejects.toThrow('connection_conflict');
  const old = await serviceOwnerPeer(f.profile, false);
  cleanup.push(() => old.close());
  await expect(
    old.request('service.connection-set', { ...request, requestId: 'old' }),
  ).rejects.toThrow('service_runtime_upgrade_required');
});
it('concurrent exact-version clients have one mutation winner; strict requests and maintenance cannot mutate', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  let host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  const a = await serviceOwnerPeer(f.profile),
    b = await serviceOwnerPeer(f.profile);
  cleanup.push(() => a.close());
  cleanup.push(() => b.close());
  const request = {
    requestId: 'create',
    connectionId: 'test',
    expectedVersions: null,
    name: 'Original',
    configuration: { kind: 'http', url: 'http://127.0.0.1:1/mcp' },
    metadataPermission: 'none',
  };
  await a.request('service.connection-set', request);
  const expectedVersions = { configRevision: 1, trustRevision: 1, credentialRevision: 1 };
  const results = await Promise.allSettled([
    a.request('service.connection-set', {
      ...request,
      requestId: 'a',
      expectedVersions,
      name: 'A',
    }),
    b.request('service.connection-set', {
      ...request,
      requestId: 'b',
      expectedVersions,
      name: 'B',
    }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  await expect(
    a.request('service.connection-set', {
      ...request,
      requestId: 'extra',
      trust: { ownerId: 'client' },
    }),
  ).rejects.toThrow('invalid_params');
  await expect(a.request('service.connections', { ownerId: 'client' })).rejects.toThrow(
    'invalid_params',
  );
  await expect(
    a.request('service.connection-set', {
      ...request,
      requestId: 'stdio',
      configuration: {
        kind: 'stdio',
        executable: '/synthetic/enrolled.mjs',
        sha256: 'a'.repeat(64),
        args: [],
      },
      key: 'synthetic',
    }),
  ).rejects.toThrow('invalid_params');
  a.close();
  b.close();
  await host.stop();
  host = await startLocalRuntime({ profile: f.profile, provider: null, restore: true });
  const maintenance = await serviceOwnerPeer(f.profile);
  cleanup.push(() => maintenance.close());
  expect(await maintenance.request('service.connections', {})).toHaveLength(1);
  expect(await maintenance.request('service.grants', {})).toEqual([]);
  await expect(
    maintenance.request('service.connection-set', { ...request, requestId: 'maintenance' }),
  ).rejects.toThrow('restore_restricted');
  await expect(
    maintenance.request('service.connection-refresh', {
      requestId: 'metadata',
      connectionId: 'test',
      expectedVersions,
    }),
  ).rejects.toThrow('restore_restricted');
});
