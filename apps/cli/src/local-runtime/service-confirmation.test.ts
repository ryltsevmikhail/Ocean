import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import { LOCAL_SERVICE_CONFIRMATIONS } from '@runnets/contracts';
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
it.each(['confirm', 'autonomous'] as const)(
  'normal host %s executes one verified effect with two owner clients',
  async (mode) => {
    const f = await privateRoot();
    cleanup.push(() => f.dispose());
    let claimAtPeer = 0;
    const http = await httpFixture('normal', undefined, 0, () => {
      claimAtPeer = journal(f.profile).length;
    });
    cleanup.push(() => http.close());
    const p = confirmedProvider();
    const host = await startLocalRuntime({ profile: f.profile, provider: p.provider });
    cleanup.push(() => host.stop());
    await configureService(f, http.url.href, mode);
    const a = await connectLocalRuntime({ profile: f.profile }),
      b = await connectLocalRuntime({ profile: f.profile });
    cleanup.push(
      () => a.close(),
      () => b.close(),
    );
    expect(a.identity.capabilities).toContain(LOCAL_SERVICE_CONFIRMATIONS);
    const scope = { workspaceId: 'ws_ocean', roomId: f.roomId };
    const turn = await a.submit({ ...scope, requestId: 'turn', text: 'call' });
    if (mode === 'confirm') {
      const card = await pendingService(a, f);
      expect(card).toMatchObject({ kind: 'service-call', expiresAt: card.createdAt + 300000 });
      expect(journal(f.profile)).toHaveLength(0);
      expect(http.stats).toMatchObject({ calls: 0, effects: 0 });
      expect(p.facts).toMatchObject({ requests: 1, answers: 0 });
      const ref = { ...scope, runId: turn.runId!, decisionId: card.decisionId };
      expect(await b.getDecision(ref)).toEqual(card);
      const previews = await Promise.all([a.decisionPreview(ref), b.decisionPreview(ref)]);
      expect(previews[0]).toBe(previews[1]);
      expect(previews[0]!.length).toBeGreaterThan(32768);
      expect(previews[0]).toContain('\\u202e');
      expect(createHash('sha256').update(previews[0]!).digest('hex')).toBe(card.bindingDigest);
      const operation = JSON.parse(previews[0]!) as {
        request: object;
        effect: { binding: object };
      };
      expect(operation.request).not.toHaveProperty('catalogId');
      expect(operation.effect.binding).not.toHaveProperty('configRevision');
      const legacy = await serviceOwnerPeer(f.profile, false);
      cleanup.push(() => legacy.close());
      for (const [method, params] of [
        ['decisions.list', scope],
        ['decisions.get', ref],
        ['decisions.preview', { ...ref, offset: 0 }],
        [
          'decisions.resolve',
          { ...ref, choice: 'allow-once', expectedVersion: 1, bindingDigest: card.bindingDigest },
        ],
      ] as const)
        await expect(legacy.request(method, params)).rejects.toThrow(
          'service_confirmation_upgrade_required',
        );
      await expect(a.getDecision({ ...ref, roomId: 'foreign' })).rejects.toThrow(
        'unknown_decision',
      );
      await expect(a.getDecision({ ...ref, runId: 'foreign' })).rejects.toThrow('unknown_decision');
      await expect(
        a.resolveDecision({
          ...ref,
          choice: 'allow-once',
          expectedVersion: 99,
          bindingDigest: card.bindingDigest,
        }),
      ).rejects.toThrow('version_conflict');
      await expect(
        a.resolveDecision({
          ...ref,
          choice: 'allow-once',
          expectedVersion: 1,
          bindingDigest: 'f'.repeat(64),
        }),
      ).rejects.toThrow('binding_conflict');
      const reply = {
        ...ref,
        choice: 'allow-once' as const,
        expectedVersion: 1,
        bindingDigest: card.bindingDigest,
      };
      const replies = await Promise.all([a.resolveDecision(reply), b.resolveDecision(reply)]);
      expect(replies[0]).toEqual(replies[1]);
      expect(replies[0]).toMatchObject({ status: 'allowed', version: 2 });
    }
    expect(await completedRun(a, f, turn.runId!)).toMatchObject({ turnStatus: 'completed' });
    expect(http.stats).toMatchObject({ calls: 1, effects: 1 });
    expect(claimAtPeer).toBe(1);
    expect(journal(f.profile)).toHaveLength(1);
    expect(p.facts).toMatchObject({ requests: 2, answers: 1 });
    expect((await a.history(scope)).filter((m) => m.author === 'bot')).toHaveLength(1);
    if (mode === 'autonomous') expect(await a.listDecisions(scope)).toEqual([]);
  },
);
