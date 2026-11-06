import { expect, it, vi } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import {
  managedNativeFixture,
  nativeJournal,
  counter,
  recordManagedCleanup,
  observeManaged,
  managedRetired,
  enrollManaged,
  type ManagedSetup,
} from '../../test-fixtures/managed-workspace-native.ts';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains an idle lifetime as uncertain after the actual 120 second native unit expiry',
  async () => {
    const f = await managedNativeFixture();
    const a = f.workspace('expiring', 'idle'),
      b = f.workspace('b');
    const owner = child('managed-workspace-owner.test.ts', ['new', f.proof], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (await owner.ready) as ManagedSetup;
    let paused = false;
    try {
      await enrollManaged(setup, f, 'expiring', a);
      const observed = await observeManaged(setup.profile, f.proof, 'expiry', 'expiring');
      const { ctl } =
        await import('../../../../packages/integrations-mcp/test-fixtures/native-observation.ts');
      const properties = ctl(
        'show',
        observed.unit,
        '--property=RuntimeMaxUSec',
        '--property=KillMode',
      );
      expect(properties).toContain('RuntimeMaxUSec=2min');
      writeFileSync(join(f.proof, 'expiry-properties'), properties);
      writeFileSync(join(a, 'idle-release'), 'write under the admitted idle lifetime');
      await vi.waitFor(() => expect(counter(a, 'idle')).toBe(1), { timeout: 3000 });
      owner.p.kill('SIGSTOP');
      paused = true;
      await vi.waitFor(
        async () => expect(await managedRetired(observed, f.proof, 'expiry')).toBe(true),
        { timeout: 130000, interval: 100 },
      );
      expect(nativeJournal(setup.profile)[0]?.outcome).toBe('started');
      owner.p.kill('SIGCONT');
      paused = false;
      await vi.waitFor(() => expect(nativeJournal(setup.profile)[0]?.outcome).toBe('uncertain'), {
        timeout: 10000,
      });
      const peer = await serviceOwnerPeer(setup.profile);
      try {
        const rows = (await peer.request('service.connections', {})) as {
          id: string;
          readiness: string;
        }[];
        expect(rows.find((r) => r.id === 'expiring')?.readiness).not.toBe('ready');
      } finally {
        peer.close();
      }
      expect(counter(a, 'startup')).toBe(1);
      await expect(enrollManaged(setup, f, 'same-expired', a)).rejects.toThrow();
      await enrollManaged(setup, f, 'b', b);
      expect(counter(b, 'startup')).toBe(1);
      writeFileSync(
        join(f.proof, 'expiry-final.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
    } finally {
      if (paused) owner.p.kill('SIGCONT');
      await owner.call('close').catch(() => {});
      await owner.kill();
      await recordManagedCleanup(setup.profile, f.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  145000,
);
