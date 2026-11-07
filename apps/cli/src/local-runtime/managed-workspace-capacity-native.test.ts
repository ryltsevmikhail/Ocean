import { expect, it, vi } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import type { ServiceConnection } from '@runnets/domain';
import {
  managedNativeFixture,
  nativeJournal,
  counter,
  observeManaged,
  managedRetired,
  recordManagedCleanup,
  enrollManaged,
  type ManagedSetup,
} from '../../test-fixtures/managed-workspace-native.ts';
type View = ServiceConnection & { readiness: string };
async function capacity() {
  const f = await managedNativeFixture(),
    root = f.workspace('a'),
    ninth = f.workspace('ninth');
  let http: ReturnType<typeof child> | undefined;
  let httpReady = false;
  let owner: ReturnType<typeof child> | undefined;
  let ownedSetup: ManagedSetup | undefined;
  let peer: Awaited<ReturnType<typeof serviceOwnerPeer>> | undefined;
  let failed = false;
  let failure: unknown;
  let cleanupError: Error | undefined;
  try {
    http = child(
      '../../../packages/integrations-mcp/test-fixtures/capacity-http-process.ts',
      [f.proof],
      process.env,
    );
    const urls = (await http.ready) as string[];
    httpReady = true;
    owner = child('managed-workspace-owner.test.ts', ['new', f.proof], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (ownedSetup = (await owner.ready) as ManagedSetup);
    peer = await serviceOwnerPeer(setup.profile);
    const activePeer = peer;
    const views = async () => (await activePeer.request('service.connections', {})) as View[];
    const refresh = async (id: string, requestId: string) => {
      const c = (await views()).find((v) => v.id === id)!;
      return activePeer.request('service.connection-refresh', {
        connectionId: id,
        requestId,
        expectedVersions: {
          configRevision: c.configRevision,
          trustRevision: c.trustRevision,
          credentialRevision: c.credentialRevision,
        },
      });
    };
    for (let n = 0; n < 7; n++) {
      await peer.request('service.connection-set', {
        requestId: 'http-set-' + n,
        connectionId: 'h' + n,
        expectedVersions: null,
        name: 'HTTP' + n,
        metadataPermission: 'allow',
        configuration: { kind: 'http', url: urls[n]! },
      });
      await refresh('h' + n, 'http-refresh-' + n);
    }
    await enrollManaged(setup, f, 'a', root);
    const initial = await views(),
      httpCatalogs = initial
        .filter((v) => v.id.startsWith('h'))
        .map((v) => [v.id, v.currentCatalogId] as const);
    expect(initial).toHaveLength(8);
    expect(initial.every((v) => v.readiness === 'ready')).toBe(true);
    const first = await observeManaged(setup.profile, f.proof, 'capacity-first', 'a');
    await expect(enrollManaged(setup, f, 'ninth', ninth)).rejects.toThrow();
    expect(counter(ninth, 'startup')).toBe(0);
    await refresh('a', 'capacity-manual');
    expect(counter(root, 'startup')).toBe(2);
    expect(await managedRetired(first, f.proof, 'capacity-first')).toBe(true);
    const second = await observeManaged(setup.profile, f.proof, 'capacity-second', 'a');
    await vi.waitFor(
      async () => {
        const current = await views();
        expect(nativeJournal(setup.profile).some((r) => r.outcome === 'uncertain')).toBe(false);
        expect(counter(root, 'startup')).toBe(3);
        expect(current.filter((v) => v.readiness === 'ready')).toHaveLength(8);
        for (const [id, catalog] of httpCatalogs)
          expect(current.find((v) => v.id === id)?.currentCatalogId).not.toBe(catalog);
      },
      { timeout: 70000, interval: 200 },
    );
    await owner.call('requests');
    const current = await views();
    expect(current.filter((v) => v.readiness === 'ready')).toHaveLength(8);
    expect(await managedRetired(second, f.proof, 'capacity-second')).toBe(true);
    expect(nativeJournal(setup.profile).map((r) => r.outcome)).toEqual([
      'completed',
      'completed',
      'started',
    ]);
    await expect(refresh('ninth', 'capacity-ninth-after')).rejects.toThrow();
    expect(counter(ninth, 'startup')).toBe(0);
    expect(counter(root, 'mutation')).toBe(0);
    expect(
      (await http.call<{ effects: number; calls: number }[]>('stats')).every(
        (v) => v.effects === 0 && v.calls === 0,
      ),
    ).toBe(true);
    writeFileSync(
      join(f.proof, 'capacity-final.json'),
      JSON.stringify(
        {
          boundary:
            'seven real loopback HTTP SDK sessions plus one native managed stdio; not eight simultaneous stdio',
          httpCatalogs,
          initial,
          current,
          rows: nativeJournal(setup.profile),
          startup: counter(root, 'startup'),
          ninthStartup: counter(ninth, 'startup'),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => peer?.close()),
      (async () => {
        if (!owner) return;
        if (ownedSetup) await owner.call('close').catch(() => {});
        await owner.kill();
      })(),
      (async () => {
        if (!http) return;
        try {
          if (httpReady) await http.call('close');
        } finally {
          await http.kill();
        }
      })(),
    ]);
    if (ownedSetup) {
      cleanup.push(
        ...(await Promise.allSettled([recordManagedCleanup(ownedSetup.profile, f.proof)])),
      );
    }
    const errors = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [String(result.reason)] : [],
    );
    if (errors.length)
      writeFileSync(join(f.proof, 'capacity-cleanup-errors.json'), JSON.stringify(errors));
    else if (ownedSetup) rmSync(ownedSetup.root, { recursive: true, force: true });
    if (errors.length) cleanupError = Error('capacity cleanup unconfirmed: ' + errors.join('; '));
  }
  if (failed) throw failure;
  if (cleanupError) throw cleanupError;
}
it.each(['partial', 'unconfirmed'])(
  'retains cleanup evidence on %s HTTP setup failure',
  async (mode) => {
    const f = await managedNativeFixture();
    const listener = child(
      '../../../packages/integrations-mcp/test-fixtures/capacity-http-process.ts',
      [f.proof, mode],
      process.env,
    );
    try {
      await expect(listener.ready).rejects.toThrow('child_exit');
      const evidence = JSON.parse(readFileSync(join(f.proof, 'http-cleanup.json'), 'utf8')) as {
        count: number;
        errors: string[];
      };
      expect(evidence.count).toBe(1);
      expect(evidence.errors).toEqual(
        mode === 'unconfirmed' ? ['injected retirement unconfirmed'] : [],
      );
      await expect(fetch(readFileSync(join(f.proof, 'partial-url.txt'), 'utf8'))).rejects.toThrow();
    } finally {
      await listener.kill();
    }
  },
);
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains readiness across default TTL at eight mixed SDK slots and joins native managed replacement',
  () => capacity(),
  85000,
);
