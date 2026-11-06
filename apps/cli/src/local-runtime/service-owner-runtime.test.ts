import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import type { ProviderPort } from '@runnets/application';
import type { ServiceConnection, ServiceConnectionVersions } from '@runnets/domain';
import { connectLocalRuntime } from '@runnets/tools-node';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { privateRoot, completedRun } from '../../test-fixtures/local-provider-host.test.js';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import { startLocalRuntime } from './host.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
const versions = ({
  configRevision,
  trustRevision,
  credentialRevision,
}: ServiceConnectionVersions) => ({ configRevision, trustRevision, credentialRevision });
function provider(): ProviderPort {
  return {
    id: 'deepseek',
    models: ['deepseek-flash'],
    capabilities: { streaming: true, reasoning: false, usage: false, toolCalls: true },
    async *stream(request) {
      if (request.messages.at(-1)?.role === 'tool' || !request.tools?.length)
        yield { type: 'text_delta', text: 'done' };
      else
        yield {
          type: 'tool_call',
          call: { id: 'call', name: request.tools[0]!.name, arguments: '{"value":"alpha"}' },
        };
      yield {
        type: 'completed',
        stopReason:
          request.messages.at(-1)?.role === 'tool' || !request.tools?.length
            ? 'stop'
            : 'tool_calls',
        rawStopReason: 'scripted',
      };
    },
  };
}
it.each([false, true])(
  'owner API grants the normal admitted tool path and held revoke=%s sends only with current authority',
  async (revoke) => {
    const f = await privateRoot();
    cleanup.push(() => f.dispose());
    const http = await httpFixture('normal');
    cleanup.push(() => http.close());
    const host = await startLocalRuntime({
      profile: f.profile,
      provider: provider(),
      serviceTransportOptions: {
        prepareDispatch: async () => {
          if (revoke)
            await peer.request('service.grant-revoke', {
              requestId: 'revoke',
              grantId: 'grant',
              expectedRevision: 1,
            });
        },
      },
    });
    cleanup.push(() => host.stop());
    const peer = await serviceOwnerPeer(f.profile);
    cleanup.push(() => peer.close());
    expect(host.identity.capabilities).toContain('service.authority-v2');
    const input = {
      requestId: 'set',
      connectionId: 'test',
      expectedVersions: null,
      name: 'Owned',
      configuration: { kind: 'http', url: http.url.href },
      metadataPermission: 'allow',
    };
    const saved = (await peer.request('service.connection-set', input)) as {
      result: ServiceConnection;
    };
    const fresh = (await peer.request('service.connection-refresh', {
      requestId: 'refresh',
      connectionId: 'test',
      expectedVersions: versions(saved.result),
    })) as { result: ServiceConnection };
    const lists = http.rows.filter((m) => m === 'tools/list').length;
    expect(
      await peer.request('service.connection-refresh', {
        requestId: 'refresh',
        connectionId: 'test',
        expectedVersions: versions(saved.result),
      }),
    ).toEqual(fresh);
    expect(http.rows.filter((m) => m === 'tools/list')).toHaveLength(lists);
    expect(await peer.request('service.connections', {})).toMatchObject([
      { id: 'test', tools: ['write'] },
    ]);
    const grant = {
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
            trustRevision: fresh.result.trustRevision,
            tools: { kind: 'current-set', names: ['write'] },
            resources: [{ kind: 'connection', connectionId: 'test' }],
          },
        ],
        limits: { maxCalls: 3, maxEffectBytes: 65536, expiresAt: null },
      },
    };
    await expect(
      peer.request('service.grant-set', {
        ...grant,
        requestId: 'foreign-subject',
        intent: { ...grant.intent, subject: { ...grant.intent.subject, roomId: 'foreign' } },
      }),
    ).rejects.toThrow('invalid_owner_scope');
    expect(await peer.request('service.grants', {})).toEqual([]);
    expect(http.stats.calls).toBe(0);
    expect(await peer.request('service.grant-set', grant)).toMatchObject({
      state: 'completed',
      result: { mode: 'autonomous', revision: 1 },
    });
    const client = await connectLocalRuntime({ profile: f.profile });
    cleanup.push(() => client.close());
    const turn = await client.submit({
      workspaceId: 'ws_ocean',
      roomId: f.roomId,
      requestId: 'turn',
      text: 'call',
    });
    expect(await completedRun(client, f, turn.runId!)).toMatchObject({ turnStatus: 'completed' });
    expect(http.stats.calls).toBe(revoke ? 0 : 1);
    expect(http.stats.effects).toBe(revoke ? 0 : 1);
    const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(1);
    db.close();
    const second = await serviceOwnerPeer(f.profile);
    cleanup.push(() => second.close());
    expect(await second.request('service.receipt', { requestId: 'refresh' })).toEqual(fresh);
  },
);
it('saved credential rotation invalidates the old grant and restart replays the original keyless receipt', async () => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  const http = await httpFixture('normal');
  cleanup.push(() => http.close());
  let host = await startLocalRuntime({ profile: f.profile, provider: provider() });
  cleanup.push(() => host.stop());
  let peer = await serviceOwnerPeer(f.profile);
  cleanup.push(() => peer.close());
  const input = {
    requestId: 'set',
    connectionId: 'test',
    expectedVersions: null,
    name: 'Owned',
    configuration: { kind: 'http', url: http.url.href },
    metadataPermission: 'allow',
    key: 'synthetic-key-A',
  };
  const first = (await peer.request('service.connection-set', input)) as {
    result: ServiceConnection;
  };
  const fresh = (await peer.request('service.connection-refresh', {
    requestId: 'refresh',
    connectionId: 'test',
    expectedVersions: versions(first.result),
  })) as { result: ServiceConnection };
  await peer.request('service.grant-set', {
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
          trustRevision: fresh.result.trustRevision,
          tools: { kind: 'exact', names: ['write'] },
          resources: [{ kind: 'connection', connectionId: 'test' }],
        },
      ],
      limits: { maxCalls: 3, maxEffectBytes: 65536, expiresAt: null },
    },
  });
  const changed = (await peer.request('service.connection-set', {
    ...input,
    requestId: 'rotate',
    expectedVersions: versions(fresh.result),
    key: 'synthetic-key-B',
  })) as { result: ServiceConnection };
  await peer.request('service.connection-refresh', {
    requestId: 'refresh-b',
    connectionId: 'test',
    expectedVersions: versions(changed.result),
  });
  const client = await connectLocalRuntime({ profile: f.profile });
  const turn = await client.submit({
    workspaceId: 'ws_ocean',
    roomId: f.roomId,
    requestId: 'turn',
    text: 'call',
  });
  await completedRun(client, f, turn.runId!);
  client.close();
  expect(http.stats.calls).toBe(0);
  peer.close();
  expect(await host.stop()).toMatchObject({ outcome: 'complete' });
  host = await startLocalRuntime({ profile: f.profile, provider: null });
  peer = await serviceOwnerPeer(f.profile);
  cleanup.push(() => peer.close());
  expect(await peer.request('service.connection-set', input)).toEqual(first);
  const wire = JSON.stringify(await peer.request('service.connections', {}));
  for (const secret of [input.key, 'synthetic-key-B']) {
    expect(wire).not.toContain(secret);
    expect(readFileSync(join(f.profile, 'runtime.sqlite')).includes(Buffer.from(secret))).toBe(
      false,
    );
  }
});
