import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalJson } from '@runnets/domain';
import { journal } from '../test-fixtures/service-confirmation-rig.js';
import { catalogRig } from '../test-fixtures/service-catalog-rig.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function rig() {
  const r = await catalogRig();
  cleanup.push(() => r.close());
  return r;
}
const metadata = (r: Awaited<ReturnType<typeof rig>>) =>
  r.traffic.filter((t) => ['initialize', 'tools/list', 'server/discover'].includes(t.method));

it('uses the full published definition beyond SDK TTL without hidden discovery', async () => {
  const r = await rig();
  const before = r.current().catalog!;
  const originalNow = Date.now;
  vi.spyOn(Date, 'now').mockImplementation(() => originalNow() + 16 * 60000);
  r.controls.extra = true;
  const turn = await r.submit();
  await r.complete(turn.runId!);
  await delay(100);
  expect(metadata(r).map((t) => t.method)).toEqual(['initialize', 'tools/list']);
  expect(r.current().catalog).toEqual(before);
  expect(r.calls()).toHaveLength(1);
  expect(r.calls()[0]!.claims).toBe(1);
  expect(r.facts).toMatchObject({ requests: 2, answers: 1 });
});

it('tools-changed schedules only a durable permissioned owner generation', async () => {
  const r = await rig();
  const before = r.current().catalog!;
  r.controls.notify = true;
  const turn = await r.submit();
  await r.complete(turn.runId!);
  r.controls.notify = false;
  await vi.waitFor(() => expect(r.current().catalog?.id).not.toBe(before.id));
  const fresh = r.current().catalog!;
  expect(fresh.tools[0]).toEqual(before.tools[0]);
  const next = await r.submit();
  await r.complete(next.runId!);
  await delay(100);
  expect(metadata(r).map((t) => [t.method, t.revision, t.permission])).toEqual([
    ['initialize', before.configRevision, 'allow'],
    ['tools/list', before.configRevision, 'allow'],
    ['initialize', before.configRevision + 1, 'allow'],
    ['tools/list', before.configRevision + 1, 'allow'],
  ]);
  expect(r.calls()).toHaveLength(2);
  expect(journal(r.f.profile)).toHaveLength(2);
});

it('delayed stale initialization stays owned and cannot list after runtime drain', async () => {
  const r = await rig();
  const before = r.current().catalog!;
  let release = () => {};
  r.controls.initializeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  r.controls.notify = true;
  const turn = await r.submit();
  await r.complete(turn.runId!);
  await vi.waitFor(() =>
    expect(metadata(r).filter((t) => t.method === 'initialize')).toHaveLength(2),
  );
  expect(metadata(r).at(-1)).toMatchObject({
    revision: before.configRevision + 1,
    permission: 'allow',
  });
  try {
    expect(await r.host.stop()).toMatchObject({ state: 'stopped', outcome: 'complete' });
  } finally {
    release();
  }
  await delay(150);
  expect(metadata(r).map((t) => t.method)).toEqual(['initialize', 'tools/list', 'initialize']);
  expect(r.calls()).toHaveLength(1);
  expect(journal(r.f.profile)).toHaveLength(1);
});

it.each(['same', 'definition', 'endpoint', 'credential', 'grant', 'ungranted'] as const)(
  'normal waiting model across refresh: %s',
  async (mode) => {
    const r = await rig();
    const original = r.current().catalog!;
    let release = () => {};
    r.controls.holdModel = new Promise<void>((resolve) => {
      release = resolve;
    });
    cleanup.push(async () => release());
    const turn = await r.submit();
    await vi.waitFor(() => expect(r.snapshots()).toBe(1));
    expect(journal(r.f.profile)).toHaveLength(0);
    if (mode === 'definition') r.controls.description = 'changed selected definition';
    if (mode === 'grant')
      await r.owner.request('service.grant-revoke', {
        requestId: 'revoke',
        grantId: 'grant',
        expectedRevision: 1,
      });
    if (['endpoint', 'credential'].includes(mode)) {
      const c = r.current().connection!;
      await r.owner.request('service.connection-set', {
        requestId: 'change',
        connectionId: c.id,
        expectedVersions: {
          configRevision: c.configRevision,
          trustRevision: c.trustRevision,
          credentialRevision: c.credentialRevision,
        },
        name: c.name,
        configuration:
          mode === 'endpoint' && c.configuration.kind === 'http'
            ? { ...c.configuration, url: c.configuration.url + '/other-account' }
            : c.configuration,
        metadataPermission: 'allow',
        ...(mode === 'credential' ? { key: 'synthetic-new-account-key' } : {}),
      });
    }
    r.controls.extra = true;
    await r.refresh();
    const fresh = r.current().catalog!;
    expect(fresh.id).not.toBe(original.id);
    if (mode === 'ungranted')
      r.controls.selectedName =
        'mcp_' +
        createHash('sha256')
          .update(canonicalJson(['test', 'ungranted']))
          .digest('hex')
          .slice(0, 56);
    release();
    await r.complete(turn.runId!);
    expect(r.calls()).toHaveLength(mode === 'same' ? 1 : 0);
    expect(journal(r.f.profile)).toHaveLength(mode === 'same' ? 1 : 0);
    if (mode === 'same') {
      expect(r.facts).toMatchObject({ requests: 2, answers: 1 });
      const row = journal(r.f.profile)[0]!;
      const persisted = JSON.stringify(row);
      expect(persisted).toContain(fresh.id);
      expect(persisted).not.toContain(original.id);
    }
    expect(metadata(r).filter((t) => t.method === 'tools/list')).toHaveLength(2);
    expect(await r.client.listDecisions({ workspaceId: 'ws_ocean', roomId: r.f.roomId })).toEqual(
      [],
    );
  },
);

it('a queued notification cannot authorize metadata after current permission is revoked', async () => {
  const r = await rig();
  r.controls.notify = true;
  r.controls.onCall = () => r.denyMetadata();
  const turn = await r.submit();
  await r.complete(turn.runId!);
  await delay(100);
  expect(r.calls()).toHaveLength(1);
  expect(metadata(r).map((t) => t.method)).toEqual(['initialize', 'tools/list']);
  expect(r.current().connection!.trust.metadataPermission).toBe('none');
});
