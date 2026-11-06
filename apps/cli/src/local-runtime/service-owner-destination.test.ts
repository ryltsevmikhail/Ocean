import { afterEach, expect, it } from 'vitest';
import type { ServiceConnection } from '@runnets/domain';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { privateRoot } from '../../test-fixtures/local-provider-host.test.js';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import { startLocalRuntime } from './host.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const tuple = (c: ServiceConnection) => ({
  configRevision: c.configRevision,
  trustRevision: c.trustRevision,
  credentialRevision: c.credentialRevision,
});
it.each(['material', 'removal'])(
  'cross-origin transfer requires explicit %s and never sends the previous bearer to the new origin',
  async (action) => {
    const f = await privateRoot();
    cleanup.push(() => f.dispose());
    const a = await httpFixture('normal'),
      b = await httpFixture('normal');
    cleanup.push(() => a.close());
    cleanup.push(() => b.close());
    const host = await startLocalRuntime({ profile: f.profile, provider: null });
    cleanup.push(() => host.stop());
    const peer = await serviceOwnerPeer(f.profile);
    cleanup.push(() => peer.close());
    const input = {
      requestId: 'initial',
      connectionId: 'test',
      expectedVersions: null,
      name: 'Owned',
      configuration: { kind: 'http' as const, url: a.url.href },
      metadataPermission: 'allow' as const,
    };
    const initial = (await peer.request('service.connection-set', {
      ...input,
      key: 'synthetic-key-A',
    })) as { result: ServiceConnection };
    const refresh = async (c: ServiceConnection, id: string) =>
      (
        (await peer.request('service.connection-refresh', {
          requestId: id,
          connectionId: 'test',
          expectedVersions: tuple(c),
        })) as { result: ServiceConnection }
      ).result;
    const current = await refresh(initial.result, 'metadata-a');
    expect(a.authorizations.filter((r) => r.method === 'tools/list')).toEqual([
      { method: 'tools/list', authorization: 'Bearer synthetic-key-A' },
    ]);
    const cross = {
      ...input,
      requestId: 'implicit-cross',
      expectedVersions: tuple(current),
      configuration: { kind: 'http' as const, url: b.url.href },
    };
    await expect(peer.request('service.connection-set', cross)).rejects.toThrow('invalid_params');
    expect(b.authorizations).toEqual([]);
    expect(await peer.request('service.receipt', { requestId: 'implicit-cross' })).toBeNull();
    const same = (await peer.request('service.connection-set', {
      ...input,
      requestId: 'same-origin',
      expectedVersions: tuple(current),
      configuration: { kind: 'http', url: new URL('/another-route', a.url).href },
    })) as { result: ServiceConnection };
    expect(same.result.trustRevision).toBe(current.trustRevision + 1);
    expect(same.result.credentialRevision).toBe(current.credentialRevision);
    const retained = await refresh(same.result, 'metadata-same');
    expect(
      a.authorizations.filter((r) => r.method === 'tools/list').map((r) => r.authorization),
    ).toEqual(['Bearer synthetic-key-A', 'Bearer synthetic-key-A']);
    const transferred = (await peer.request('service.connection-set', {
      ...cross,
      requestId: 'explicit-cross',
      expectedVersions: tuple(retained),
      ...(action === 'material' ? { key: 'synthetic-key-B' } : { removeKey: true }),
    })) as { result: ServiceConnection };
    await refresh(transferred.result, 'metadata-b');
    expect(b.authorizations.filter((r) => r.method === 'tools/list')).toEqual([
      {
        method: 'tools/list',
        authorization: action === 'material' ? 'Bearer synthetic-key-B' : '',
      },
    ]);
    expect(b.authorizations.some((r) => r.authorization === 'Bearer synthetic-key-A')).toBe(false);
  },
);
