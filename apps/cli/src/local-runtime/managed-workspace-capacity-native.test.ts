import { expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.ts';
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
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains readiness across default TTL at eight mixed SDK slots and joins native managed replacement',
  async () => {
    const f = await managedNativeFixture(),
      root = f.workspace('a'),
      ninth = f.workspace('ninth');
    const http = await Promise.all(
      Array.from({ length: 7 }, () => httpFixture('normal', undefined, 60000)),
    );
    const owner = child('managed-workspace-owner.test.ts', ['new', f.proof], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (await owner.ready) as ManagedSetup,
      peer = await serviceOwnerPeer(setup.profile);
    const views = async () => (await peer.request('service.connections', {})) as View[];
    const refresh = async (id: string, requestId: string) => {
      const c = (await views()).find((v) => v.id === id)!;
      return peer.request('service.connection-refresh', {
        connectionId: id,
        requestId,
        expectedVersions: {
          configRevision: c.configRevision,
          trustRevision: c.trustRevision,
          credentialRevision: c.credentialRevision,
        },
      });
    };
    try {
      for (let n = 0; n < 7; n++) {
        await peer.request('service.connection-set', {
          requestId: 'http-set-' + n,
          connectionId: 'h' + n,
          expectedVersions: null,
          name: 'HTTP' + n,
          metadataPermission: 'allow',
          configuration: { kind: 'http', url: http[n]!.url.href },
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
      expect(http.every((v) => v.stats.effects === 0 && v.stats.calls === 0)).toBe(true);
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
    } finally {
      peer.close();
      await owner.call('close').catch(() => {});
      await owner.kill();
      await Promise.all(http.map((v) => v.close()));
      await recordManagedCleanup(setup.profile, f.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  85000,
);
