import { afterEach, expect, it } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { privateRoot, completedRun } from '../../test-fixtures/local-provider-host.test.js';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import {
  confirmedProvider,
  configureService,
  pendingService,
  journal,
} from '../../test-fixtures/service-confirmation-rig.js';
import { startLocalRuntime } from './host.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
it.each([
  'deny',
  'expire',
  'revoke',
  'refresh',
  'definition',
  'credential',
  'abort',
  'stop',
  'prepare-revoke',
] as const)('owner waiter handles %s using actual socket and SQLite authority', async (mode) => {
  const f = await privateRoot();
  cleanup.push(() => f.dispose());
  const http = await httpFixture('normal');
  cleanup.push(() => http.close());
  const p = confirmedProvider();
  let now = 1000;
  const host = await startLocalRuntime({
    profile: f.profile,
    provider: p.provider,
    now: () => now,
    serviceTransportOptions: {
      prepareDispatch: async () => {
        if (mode === 'prepare-revoke')
          await owner.request('service.grant-revoke', {
            requestId: 'revoke',
            grantId: 'grant',
            expectedRevision: 1,
          });
      },
    },
  });
  cleanup.push(() => host.stop());
  const connection = await configureService(f, http.url.href, 'confirm');
  const owner = await serviceOwnerPeer(f.profile);
  cleanup.push(() => owner.close());
  let a = await connectLocalRuntime({ profile: f.profile });
  cleanup.push(() => a.close());
  const b = await connectLocalRuntime({ profile: f.profile });
  cleanup.push(() => b.close());
  const scope = { workspaceId: 'ws_ocean', roomId: f.roomId };
  const turn = await a.submit({ ...scope, requestId: 'turn', text: 'call' });
  const card = await pendingService(a, f);
  const ref = { ...scope, runId: turn.runId!, decisionId: card.decisionId };
  expect(journal(f.profile)).toHaveLength(0);
  a.close();
  a = await connectLocalRuntime({ profile: f.profile });
  expect(await a.getDecision(ref)).toEqual(card);
  if (mode === 'expire') now += 300000;
  if (mode === 'revoke')
    await owner.request('service.grant-revoke', {
      requestId: 'revoke',
      grantId: 'grant',
      expectedRevision: 1,
    });
  if (['refresh', 'definition', 'credential'].includes(mode)) {
    let expectedVersions = {
      configRevision: connection.configRevision,
      trustRevision: connection.trustRevision,
      credentialRevision: connection.credentialRevision,
    };
    if (mode === 'definition') http.stats.version = 'bravo';
    if (mode === 'credential') {
      const changed = (await owner.request('service.connection-set', {
        requestId: 'rotate',
        connectionId: 'test',
        expectedVersions,
        name: 'Synthetic',
        configuration: connection.configuration,
        metadataPermission: 'allow',
        key: 'synthetic-new-key',
      })) as { result: typeof connection };
      expectedVersions = {
        configRevision: changed.result.configRevision,
        trustRevision: changed.result.trustRevision,
        credentialRevision: changed.result.credentialRevision,
      };
    }
    await owner.request('service.connection-refresh', {
      requestId: 'fresh-wait',
      connectionId: 'test',
      expectedVersions,
    });
  }
  if (mode === 'stop')
    expect(await host.stop()).toMatchObject({ state: 'stopped', outcome: 'complete' });
  else {
    if (mode === 'abort') {
      const run = await a.getRun({ ...scope, runId: turn.runId! });
      await a.cancelRun({
        ...scope,
        runId: turn.runId!,
        requestId: 'cancel',
        expectedVersion: run!.version,
      });
    }
    const result = await b.resolveDecision({
      ...ref,
      choice: mode === 'deny' ? 'deny' : 'allow-once',
      expectedVersion: card.version,
      bindingDigest: card.bindingDigest,
    });
    expect(result.status).toBe(
      mode === 'deny'
        ? 'denied'
        : mode === 'expire'
          ? 'expired'
          : ['revoke', 'definition', 'credential'].includes(mode)
            ? 'invalidated'
            : mode === 'abort'
              ? 'cancelled'
              : 'allowed',
    );
    await completedRun(a, f, turn.runId!);
  }
  expect(http.stats.calls).toBe(mode === 'refresh' ? 1 : 0);
  expect(http.stats.effects).toBe(mode === 'refresh' ? 1 : 0);
  expect(journal(f.profile)).toHaveLength(['refresh', 'prepare-revoke'].includes(mode) ? 1 : 0);
  expect(p.facts.answers).toBe(mode === 'refresh' ? 1 : 0);
  expect(http.rows.filter((r) => r === 'tools/list')).toHaveLength(
    ['refresh', 'definition', 'credential'].includes(mode) ? 2 : 1,
  );
});
