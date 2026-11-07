import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import type { ServiceConnection } from '@runnets/domain';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { serviceConnection } from '../../../../test-fixtures/service-authority.js';
import { privateRoot } from '../../test-fixtures/local-provider-host.test.js';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import { startLocalRuntime } from './host.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const versions = (c: ServiceConnection) => ({
  configRevision: c.configRevision,
  trustRevision: c.trustRevision,
  credentialRevision: c.credentialRevision,
});
it.each(['missing', 'corrupt', 'insecure'])(
  'private %s state refuses metadata without environment fallback',
  async (fault) => {
    const f = await privateRoot();
    cleanup.push(() => f.dispose());
    const http = await httpFixture('normal');
    cleanup.push(() => http.close());
    const host = await startLocalRuntime({ profile: f.profile, provider: null });
    cleanup.push(() => host.stop());
    const peer = await serviceOwnerPeer(f.profile);
    cleanup.push(() => peer.close());
    const first = (await peer.request('service.connection-set', {
      requestId: 'set',
      connectionId: 'test',
      expectedVersions: null,
      name: 'Owned',
      configuration: { kind: 'http', url: http.url.href },
      metadataPermission: 'allow',
      key: 'synthetic-A',
    })) as { result: ServiceConnection };
    const path = join(f.credentialDir, 'providers.json');
    if (fault === 'missing') rmSync(path);
    if (fault === 'corrupt') writeFileSync(path, '{malformed');
    if (fault === 'insecure') chmodSync(path, 0o644);
    vi.stubEnv('SYNTHETIC', 'synthetic-A');
    await expect(
      peer.request('service.connection-refresh', {
        requestId: 'refresh',
        connectionId: 'test',
        expectedVersions: versions(first.result),
      }),
    ).rejects.toThrow('service_settings_failed');
    expect(http.rows).toEqual([]);
    expect(await peer.request('service.receipt', { requestId: 'refresh' })).toMatchObject({
      state: 'prepared',
      recovery: 'explicit_recovery_required',
    });
    const before = existsSync(path) ? readFileSync(path) : null;
    expect(
      await peer.request('service.connection-refresh', {
        requestId: 'refresh',
        connectionId: 'test',
        expectedVersions: versions(first.result),
      }),
    ).toMatchObject({ state: 'prepared' });
    expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
    expect(http.rows).toEqual([]);
  },
);
it('same environment handle with changed material refuses reconnect and restart; an unbound legacy declaration is inert', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  const http = await httpFixture('normal');
  cleanup.push(() => http.close());
  const path = join(f.profile, 'runtime.sqlite');
  const store = openSqliteStore({ path });
  store.serviceAuthority.atomic((tx) =>
    tx.putConnection(
      {
        ...serviceConnection,
        id: 'test',
        configuration: { kind: 'http', url: http.url.href },
        credentialReference: 'env:SYNTHETIC',
        credentialBinding: hash('ocean.provider.key.v1:synthetic-A'),
        trust: { ...serviceConnection.trust, ownerId: hash(realpathSync(path)) },
      },
      null,
    ),
  );
  store.close();
  vi.stubEnv('SYNTHETIC', 'synthetic-A');
  let host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  let peer = await serviceOwnerPeer(f.profile);
  cleanup.push(() => peer.close());
  expect(http.rows.filter((m) => m === 'tools/list')).toHaveLength(1);
  vi.stubEnv('SYNTHETIC', 'synthetic-B');
  const [current] = (await peer.request('service.connections', {})) as ServiceConnection[];
  const before = http.rows.length;
  await expect(
    peer.request('service.connection-refresh', {
      requestId: 'different-material',
      connectionId: 'test',
      expectedVersions: versions(current!),
    }),
  ).rejects.toThrow();
  expect(http.rows).toHaveLength(before);
  peer.close();
  await host.stop();
  host = await startLocalRuntime({ profile: f.profile, provider: null });
  expect(http.rows).toHaveLength(before);
  peer = await serviceOwnerPeer(f.profile);
  cleanup.push(() => peer.close());
  expect(await peer.request('service.receipt', { requestId: 'different-material' })).toMatchObject({
    state: 'prepared',
  });
  const saved = openSqliteStore({ path });
  const c = saved.serviceAuthority.atomic((tx) => tx.connection('test'))!;
  saved.serviceAuthority.atomic((tx) => {
    const { credentialBinding: _binding, ...legacy } = c;
    tx.putConnection({ ...legacy, credentialRevision: c.credentialRevision + 1 }, c);
  });
  saved.close();
  peer.close();
  await host.stop();
  host = await startLocalRuntime({ profile: f.profile, provider: null });
  expect(http.rows).toHaveLength(before);
});
it('explicit key removal publishes private deletion after durable intent and leaves the connection anonymous', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  const host = await startLocalRuntime({ profile: f.profile, provider: null });
  cleanup.push(() => host.stop());
  const peer = await serviceOwnerPeer(f.profile);
  cleanup.push(() => peer.close());
  const input = {
    requestId: 'set',
    connectionId: 'test',
    expectedVersions: null,
    name: 'Owned',
    configuration: { kind: 'http', url: 'http://127.0.0.1:1/mcp' },
    metadataPermission: 'none',
    key: 'synthetic-remove-key',
  };
  const first = (await peer.request('service.connection-set', input)) as {
    result: ServiceConnection;
  };
  const { key: _key, ...metadata } = input;
  const removed = await peer.request('service.connection-set', {
    ...metadata,
    requestId: 'remove',
    expectedVersions: versions(first.result),
    removeKey: true,
  });
  expect(removed).toMatchObject({
    state: 'completed',
    result: { credentialReference: null, credentialRevision: 2, trustRevision: 2 },
  });
  expect(readFileSync(join(f.credentialDir, 'providers.json'), 'utf8')).not.toContain(input.key);
});
