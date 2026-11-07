import { afterEach, expect, it, vi } from 'vitest';
import type { ServiceConnection } from '@runnets/domain';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { privateRoot } from '../../test-fixtures/local-provider-host.test.js';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import { startLocalRuntime } from './host.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of cleanup.splice(0).reverse()) await run();
});
const versions = (c: ServiceConnection) => ({
  configRevision: c.configRevision,
  trustRevision: c.trustRevision,
  credentialRevision: c.credentialRevision,
});
async function fixture() {
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
    requestId: 'set',
    connectionId: 'test',
    expectedVersions: null,
    name: 'Owned',
    configuration: { kind: 'http' as const, url: a.url.href },
    metadataPermission: 'allow' as const,
    key: 'synthetic-old-destination-key',
  };
  const initial = (await peer.request('service.connection-set', input)) as {
    result: ServiceConnection;
  };
  return { ...f, a, b, peer, input, initial };
}
it('accepted held refresh survives initiating socket detach and completes a coalesced request once', async () => {
  const f = await fixture(),
    observer = await serviceOwnerPeer(f.profile);
  cleanup.push(() => observer.close());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  cleanup.push(() => release());
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    if (typeof args[1]?.body === 'string' && args[1].body.includes('tools/list')) {
      entered();
      await held;
    }
    return original(...args);
  });
  const request = {
    requestId: 'refresh',
    connectionId: 'test',
    expectedVersions: versions(f.initial.result),
  };
  void f.peer.request('service.connection-refresh', request);
  await started;
  const [current] = (await observer.request('service.connections', {})) as ServiceConnection[];
  const coalesced = observer.request('service.connection-refresh', {
    ...request,
    requestId: 'coalesced',
    expectedVersions: versions(current!),
  });
  await vi.waitFor(async () =>
    expect(await observer.request('service.receipt', { requestId: 'coalesced' })).toMatchObject({
      state: 'prepared',
    }),
  );
  f.peer.close();
  release();
  expect(await coalesced).toMatchObject({ state: 'completed' });
  expect(await observer.request('service.receipt', { requestId: 'refresh' })).toMatchObject({
    state: 'completed',
  });
  expect(f.a.rows.filter((m) => m === 'tools/list')).toHaveLength(1);
});
it('cross-origin implicit retention and keyed stdio transition are refused without state or receipts', async () => {
  const f = await fixture(),
    old = f.initial.result;
  const { key: _key, ...metadata } = f.input;
  const edit = {
    ...metadata,
    requestId: 'foreign-origin',
    expectedVersions: versions(old),
    configuration: { kind: 'http' as const, url: f.b.url.href },
  };
  await expect(f.peer.request('service.connection-set', edit)).rejects.toThrow('invalid_params');
  expect(await f.peer.request('service.receipt', { requestId: edit.requestId })).toBeNull();
  const [same] = (await f.peer.request('service.connections', {})) as ServiceConnection[];
  expect(same?.configuration).toEqual(old.configuration);
  expect(versions(same!)).toEqual(versions(old));
  const stdio = {
    kind: 'stdio',
    executable: '/synthetic/enrolled.mjs',
    sha256: 'a'.repeat(64),
    workspaceRoot: '/synthetic/workspace',
    args: [],
  };
  await expect(
    f.peer.request('service.connection-set', { ...edit, requestId: 'stdio', configuration: stdio }),
  ).rejects.toThrow('invalid_params');
  expect(await f.peer.request('service.receipt', { requestId: 'stdio' })).toBeNull();
  const removed = (await f.peer.request('service.connection-set', {
    ...metadata,
    requestId: 'remove',
    expectedVersions: versions(old),
    removeKey: true,
  })) as { result: ServiceConnection };
  expect(
    await f.peer.request('service.connection-set', {
      ...metadata,
      requestId: 'stdio-ok',
      expectedVersions: versions(removed.result),
      configuration: stdio,
    }),
  ).toMatchObject({ state: 'completed', result: { credentialReference: null } });
  expect(f.a.rows).toEqual([]);
  expect(f.b.rows).toEqual([]);
});
it('explicit null grant mode cannot create or revise a real grant or receipt', async () => {
  const f = await fixture();
  const intent = {
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
        kind: 'coding',
        actions: ['project_read'],
        resources: [{ kind: 'project-worktree', projectId: 'project', worktreeId: null }],
      },
    ],
    limits: { maxCalls: 3, maxEffectBytes: 4096, expiresAt: null },
  };
  await expect(
    f.peer.request('service.grant-set', {
      requestId: 'bad-create',
      expectedRevision: null,
      intent: { ...intent, mode: null },
    }),
  ).rejects.toThrow('invalid_params');
  expect(await f.peer.request('service.grants', {})).toEqual([]);
  expect(await f.peer.request('service.receipt', { requestId: 'bad-create' })).toBeNull();
  const valid = await f.peer.request('service.grant-set', {
    requestId: 'valid',
    expectedRevision: null,
    intent,
  });
  expect(valid).toMatchObject({ result: { mode: 'autonomous', revision: 1 } });
  const before = await f.peer.request('service.grants', {});
  await expect(
    f.peer.request('service.grant-set', {
      requestId: 'bad-revise',
      expectedRevision: 1,
      intent: { ...intent, mode: null },
    }),
  ).rejects.toThrow('invalid_params');
  expect(await f.peer.request('service.grants', {})).toEqual(before);
  expect(await f.peer.request('service.receipt', { requestId: 'bad-revise' })).toBeNull();
  expect(
    await f.peer.request('service.grant-set', {
      requestId: 'confirm',
      expectedRevision: 1,
      intent: { ...intent, mode: 'confirm' },
    }),
  ).toMatchObject({ result: { mode: 'confirm', revision: 2 } });
});
