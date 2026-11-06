import { expect, it, vi } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
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
import type { ServiceConnection } from '@runnets/domain';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'fences live idle and interrupted idle writers, then permits only fresh disjoint enrollment',
  async () => {
    const f = await managedNativeFixture();
    const x = f.workspace('x', 'idle'),
      nested = f.workspace('x/child'),
      b = f.workspace('b');
    const env = { ...process.env, DEEPSEEK_API_KEY: 'synthetic-managed-workspace' };
    let owner = child('managed-workspace-owner.test.ts', ['new', f.proof], env);
    const setup = (await owner.ready) as ManagedSetup;
    try {
      await enrollManaged(setup, f, 'x', x);
      await vi.waitFor(() => expect(counter(x, 'idle-ready')).toBe(1), { timeout: 3000 });
      const observed = await observeManaged(setup.profile, f.proof, 'idle-x', 'x');
      await expect(enrollManaged(setup, f, 'nested', nested)).rejects.toThrow();
      expect(counter(nested, 'startup')).toBe(0);
      writeFileSync(join(x, 'idle-release'), 'go');
      await vi.waitFor(() => expect(counter(x, 'idle')).toBe(1), { timeout: 3000 });
      expect(nativeJournal(setup.profile)).toHaveLength(1);
      const peer = await serviceOwnerPeer(setup.profile);
      try {
        const connections = (await peer.request('service.connections', {})) as ServiceConnection[];
        const c = connections.find((v) => v.id === 'x')!;
        await peer.request('service.connection-disconnect', {
          requestId: 'disconnect-x',
          connectionId: 'x',
          expectedVersions: {
            configRevision: c.configRevision,
            trustRevision: c.trustRevision,
            credentialRevision: c.credentialRevision,
          },
        });
      } finally {
        peer.close();
      }
      await vi.waitFor(
        async () => expect(await managedRetired(observed, f.proof, 'idle-x')).toBe(true),
        { timeout: 5000 },
      );
      await vi.waitFor(
        () => expect(nativeJournal(setup.profile)[0]?.['outcome']).toBe('completed'),
        { timeout: 3000 },
      );
      // A different connection may use the formerly overlapping child only after joined retirement.
      await enrollManaged(setup, f, 'after', nested);
      expect(counter(nested, 'startup')).toBe(1);
      writeFileSync(join(x, 'idle-release-again'), 'no old writer');
      expect(counter(x, 'idle')).toBe(1);
      const idleRoot = f.workspace('interrupted', 'idle');
      await enrollManaged(setup, f, 'interrupted', idleRoot);
      await vi.waitFor(() => expect(counter(idleRoot, 'idle-ready')).toBe(1), { timeout: 3000 });
      const interrupted = await observeManaged(
        setup.profile,
        f.proof,
        'interrupted',
        'interrupted',
      );
      await owner.kill();
      await vi.waitFor(
        async () => expect(await managedRetired(interrupted, f.proof, 'interrupted')).toBe(true),
        { timeout: 5000 },
      );
      owner = child('managed-workspace-owner.test.ts', ['recover', f.proof], env);
      await owner.ready;
      expect(
        nativeJournal(setup.profile).find((r) => r['id'] === interrupted.row['id'])?.['outcome'],
      ).toBe('uncertain');
      expect(counter(idleRoot, 'startup')).toBe(1);
      await expect(enrollManaged(setup, f, 'idle-alias', idleRoot)).rejects.toThrow();
      expect(counter(idleRoot, 'startup')).toBe(1);
      await enrollManaged(setup, f, 'disjoint', b);
      expect(counter(b, 'startup')).toBe(1);
      writeFileSync(
        join(f.proof, 'idle-final.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
    } finally {
      await owner.call('close').catch(() => {});
      await owner.kill();
      await recordManagedCleanup(setup.profile, f.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  60000,
);
