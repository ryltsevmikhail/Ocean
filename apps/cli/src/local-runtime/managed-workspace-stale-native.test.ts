import { expect, it, vi } from 'vitest';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import {
  managedNativeFixture,
  nativeJournal,
  counter,
  recordManagedCleanup,
  enrollManaged,
  grantManaged,
  type ManagedSetup,
} from '../../test-fixtures/managed-workspace-native.ts';
import { connectLocalRuntime } from '@runnets/tools-node';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'keeps replaced saved roots conservative instead of certifying a disjoint restart exemption',
  async () => {
    const f = await managedNativeFixture(),
      a = f.workspace('a', 'drop'),
      b = f.workspace('b');
    const env = { ...process.env, DEEPSEEK_API_KEY: 'synthetic-managed-workspace' };
    let owner = child('managed-workspace-owner.test.ts', ['new', f.proof], env);
    const setup = (await owner.ready) as ManagedSetup;
    let client = await connectLocalRuntime({ profile: setup.profile });
    try {
      await enrollManaged(setup, f, 'a', a);
      await client.roomTaskStart(await grantManaged(setup, 'a'));
      await vi.waitFor(
        () =>
          expect(
            nativeJournal(setup.profile).filter((r) => r.outcome === 'uncertain'),
          ).toHaveLength(2),
        { timeout: 10000 },
      );
      client.close();
      await owner.call('close');
      await owner.kill();
      renameSync(a, a + '-moved');
      f.workspace('a');
      owner = child('managed-workspace-owner.test.ts', ['recover', f.proof], env);
      await owner.ready;
      client = await connectLocalRuntime({ profile: setup.profile });
      await expect(enrollManaged(setup, f, 'b', b)).rejects.toThrow();
      expect(counter(b, 'startup')).toBe(0);
      expect(counter(a, 'startup')).toBe(0);
      expect(counter(a + '-moved', 'startup')).toBe(1);
      writeFileSync(
        join(f.proof, 'stale-final.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
    } finally {
      client.close();
      await owner.call('close').catch(() => {});
      await owner.kill();
      await recordManagedCleanup(setup.profile, f.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  30000,
);
