import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import { privateRoot } from '../../test-fixtures/local-provider-host.test.js';
import { startLocalRuntime } from './host.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
it('a second authenticated shared client recovers prepared keyless intent after owner restart without a live row or effects', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  // Real private-store publication failure after SQLite prepared persistence.
  mkdirSync(f.credentialDir, { mode: 0o700 });
  const file = join(f.credentialDir, 'providers.json');
  writeFileSync(file, 'synthetic-invalid-private-store', { mode: 0o600 });
  let host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  const first = await connectLocalRuntime({ profile: f.profile });
  cleanup.push(() => first.close());
  expect(first).toHaveProperty('setServiceConnection');
  const request = {
    requestId: randomUUID(),
    connectionId: 'new-target',
    expectedVersions: null,
    name: 'Recoverable',
    configuration: { kind: 'http' as const, url: 'http://127.0.0.1:1/mcp' },
    metadataPermission: 'none' as const,
    key: 'synthetic-owner-client-secret',
  };
  await expect(first.setServiceConnection(request)).rejects.toThrow('provider_write_failed');
  expect(await first.serviceConnections()).toEqual([]);
  const original = await first.serviceReceipt({ requestId: request.requestId });
  expect(original).toMatchObject({ state: 'prepared', result: null });
  first.close();
  await host.stop();
  host = await startLocalRuntime({ profile: f.profile, provider: null });
  const second = await connectLocalRuntime({ profile: f.profile });
  cleanup.push(() => second.close());
  expect(second.identity.capabilities).toContain('service.owner-operations');
  const { key: _key, ...input } = request;
  expect(await second.listServiceOwnerOperations({ state: 'prepared', limit: 1 })).toEqual({
    items: [
      {
        requestId: request.requestId,
        method: 'service.connection-set',
        state: 'prepared',
        recovery: 'explicit_recovery_required',
        targetId: 'new-target',
        operation: { method: 'service.connection-set', input, requiresKey: true },
      },
    ],
    next: null,
  });
  expect(await second.serviceReceipt({ requestId: request.requestId })).toEqual(original);
  expect(await second.setServiceConnection(request)).toEqual(original);
  await expect(second.setServiceConnection({ ...request, name: 'changed' })).rejects.toThrow(
    'request_conflict',
  );
  expect(readFileSync(file, 'utf8')).toBe('synthetic-invalid-private-store');
  expect(await second.serviceGrants()).toEqual([]);
  const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'));
  expect(db.prepare('SELECT COUNT(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ocean_service_catalogs').get()?.['n']).toBe(0);
  db.close();
  rmSync(file); // Owner explicitly supplies material with a NEW request.
  const done = await second.setServiceConnection({ ...request, requestId: randomUUID() });
  expect(done.state).toBe('completed');
  expect(await second.serviceReceipt({ requestId: request.requestId })).toEqual(original);
  expect(JSON.stringify(await second.listServiceOwnerOperations({}))).not.toContain(request.key);
  expect(await second.serviceConnections()).toMatchObject([
    { id: 'new-target', readiness: 'metadata_required' },
  ]);
});
it('shared client preserves completed result snapshots across current edits and exposes maintenance history', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  let host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  const client = await connectLocalRuntime({ profile: f.profile });
  cleanup.push(() => client.close());
  expect(client).toHaveProperty('setServiceConnection');
  const input = {
    requestId: 'a',
    connectionId: 'test',
    expectedVersions: null,
    name: 'Original',
    configuration: { kind: 'http' as const, url: 'http://127.0.0.1:1/mcp' },
    metadataPermission: 'none' as const,
  };
  const original = await client.setServiceConnection(input);
  await client.disconnectServiceConnection({
    requestId: 'b',
    connectionId: 'test',
    expectedVersions: { configRevision: 1, trustRevision: 1, credentialRevision: 1 },
  });
  expect(await client.setServiceConnection(input)).toEqual(original);
  expect(await client.serviceReceipt({ requestId: 'a' })).toEqual(original);
  expect(await client.serviceConnections()).toMatchObject([
    { state: 'disconnected', readiness: 'disconnected' },
  ]);
  expect(await client.listServiceOwnerOperations({ limit: 1 })).toMatchObject({
    items: [{ requestId: 'a' }],
    next: 'a',
  });
  expect(await client.listServiceOwnerOperations({ after: 'a', limit: 1 })).toMatchObject({
    items: [{ requestId: 'b', targetId: 'test', operation: null }],
    next: null,
  });
  client.close();
  await host.stop();
  host = await startLocalRuntime({ profile: f.profile, provider: null, restore: true });
  const maintenance = await connectLocalRuntime({ profile: f.profile });
  cleanup.push(() => maintenance.close());
  expect((await maintenance.listServiceOwnerOperations({})).items).toHaveLength(2);
});
it('typed refresh and grant methods use the existing owner policy; readiness alone creates no grant', async () => {
  const { httpFixture } =
    await import('../../../../packages/integrations-mcp/src/prototype-http-fixture.js');
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  const http = await httpFixture('normal');
  cleanup.push(() => http.close());
  const host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  const client = await connectLocalRuntime({ profile: f.profile });
  cleanup.push(() => client.close());
  await client.setServiceConnection({
    requestId: 'set',
    connectionId: 'test',
    expectedVersions: null,
    name: 'Test',
    configuration: { kind: 'http', url: http.url.href },
    metadataPermission: 'allow',
  });
  const input = {
    requestId: 'refresh',
    connectionId: 'test',
    expectedVersions: { configRevision: 1, trustRevision: 1, credentialRevision: 1 },
  };
  const original = await client.refreshServiceConnection(input);
  const [current] = await client.serviceConnections();
  expect(current?.readiness).toBe('ready');
  expect(await client.serviceGrants()).toEqual([]);
  expect(http.stats.calls).toBe(0);
  const grant = await client.setOwnerScopeGrant({
    requestId: 'grant',
    expectedRevision: null,
    intent: {
      id: 'grant',
      subject: {
        workspaceId: 'ws_ocean',
        roomId: f.roomId,
        botId: f.botId,
        projectId: null,
        taskId: null,
      },
      permissions: [
        {
          kind: 'service',
          connectionId: 'test',
          trustRevision: current!.trustRevision,
          tools: { kind: 'exact', names: ['write'] },
          resources: [{ kind: 'connection', connectionId: 'test' }],
        },
      ],
      limits: { maxCalls: 1, maxEffectBytes: 4096, expiresAt: null },
    },
  });
  expect(grant).toMatchObject({ state: 'completed', result: { id: 'grant', revision: 1 } });
  expect(
    await client.revokeOwnerScopeGrant({
      requestId: 'revoke',
      grantId: 'grant',
      expectedRevision: 1,
    }),
  ).toMatchObject({ state: 'completed', result: { state: 'revoked', revision: 2 } });
  const lists = http.rows.filter((m) => m === 'tools/list').length;
  expect(await client.refreshServiceConnection(input)).toEqual(original);
  expect(await client.listServiceOwnerOperations({ state: 'completed' })).toMatchObject({
    items: expect.arrayContaining([
      {
        requestId: 'refresh',
        method: 'service.connection-refresh',
        state: 'completed',
        recovery: null,
        targetId: 'test',
        operation: { method: 'service.connection-refresh', input, requiresKey: false },
      },
    ]),
  });
  expect(http.rows.filter((m) => m === 'tools/list')).toHaveLength(lists);
  expect(http.stats.calls).toBe(0);
});
