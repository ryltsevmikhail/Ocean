import { expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import {
  managedNativeFixture,
  nativeJournal,
  counter,
  observeManaged,
  managedRetired,
  recordManagedCleanup,
  enrollManaged,
  grantManaged,
  type ManagedSetup,
} from '../../test-fixtures/managed-workspace-native.ts';
import { connectLocalRuntime } from '@runnets/tools-node';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'keeps A unknown across two ordinary host restarts while independently enrolled B starts and mutates',
  async () => {
    const fixture = await managedNativeFixture();
    const a = fixture.workspace('a/leaf', 'drop'),
      b = fixture.workspace('b');
    const env = { ...process.env, DEEPSEEK_API_KEY: 'synthetic-managed-workspace' };
    let owner = child('managed-workspace-owner.test.ts', ['new', fixture.proof], env);
    const setup = (await owner.ready) as ManagedSetup;
    let client = await connectLocalRuntime({ profile: setup.profile });
    try {
      await enrollManaged(setup, fixture, 'a', a);
      expect(counter(a, 'startup')).toBe(1);
      const observedA = await observeManaged(setup.profile, fixture.proof, 'a', 'a');
      expect(observedA.fields['pids.max']).toBe('64');
      expect(observedA.fields['memory.max']).toBe('536870912');
      const before = nativeJournal(setup.profile);
      expect(before).toMatchObject([{ task_run_id: '\0managed-stdio/v1', outcome: 'started' }]);
      writeFileSync(join(fixture.proof, 'before-call.json'), JSON.stringify(before, null, 2));
      const input = await grantManaged(setup, 'a');
      const receipt = await client.roomTaskStart(input);
      await vi.waitFor(() => expect(counter(a, 'mutation')).toBe(1), { timeout: 10000 });
      await vi.waitFor(
        () =>
          expect(
            nativeJournal(setup.profile).filter((r) => r['outcome'] === 'uncertain'),
          ).toHaveLength(2),
        { timeout: 10000 },
      );
      expect([counter(a, 'startup'), counter(a, 'received'), counter(a, 'mutation')]).toEqual([
        1, 1, 1,
      ]);
      await vi.waitFor(
        async () => expect(await managedRetired(observedA, fixture.proof, 'a')).toBe(true),
        { timeout: 5000 },
      );
      const lost = nativeJournal(setup.profile);
      writeFileSync(join(fixture.proof, 'lost.json'), JSON.stringify(lost, null, 2));
      for (let n = 0; n < 2; n++) {
        client.close();
        await owner.call('close');
        await owner.kill();
        owner = child('managed-workspace-owner.test.ts', ['recover', fixture.proof], env);
        await owner.ready;
        client = await connectLocalRuntime({ profile: setup.profile });
        expect(await client.roomTaskStart(input)).toEqual(receipt);
        expect(nativeJournal(setup.profile).filter((r) => r['outcome'] === 'uncertain')).toEqual(
          lost,
        );
        expect(counter(a, 'startup')).toBe(1);
      }
      await enrollManaged(setup, fixture, 'b', b);
      const observedB = await observeManaged(setup.profile, fixture.proof, 'b', 'b');
      const inputB = await grantManaged(setup, 'b', setup.bRoom);
      await client.roomTaskStart(inputB);
      await vi.waitFor(() => expect(counter(b, 'mutation')).toBe(1), { timeout: 10000 });
      expect([counter(b, 'startup'), counter(b, 'received'), counter(b, 'mutation')]).toEqual([
        1, 1, 1,
      ]);
      expect([counter(a, 'startup'), counter(a, 'received'), counter(a, 'mutation')]).toEqual([
        1, 1, 1,
      ]);
      await expect(enrollManaged(setup, fixture, 'same', a)).rejects.toThrow();
      await expect(
        enrollManaged(setup, fixture, 'ancestor', join(fixture.proof, 'a')),
      ).rejects.toThrow();
      await expect(
        enrollManaged(setup, fixture, 'descendant', fixture.workspace('a/leaf/nested')),
      ).rejects.toThrow();
      expect(counter(join(fixture.proof, 'a'), 'startup')).toBe(0);
      expect(counter(join(a, 'nested'), 'startup')).toBe(0);
      expect(counter(a, 'startup')).toBe(1);
      const namespace = JSON.parse(readFileSync(join(b, 'namespace.json'), 'utf8')) as {
        mounts: string;
      };
      expect(namespace.mounts).not.toMatch(/\b(?:shared|master):/);
      writeFileSync(
        join(fixture.proof, 'final.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
      await owner.call('close');
      expect(await managedRetired(observedB, fixture.proof, 'b')).toBe(true);
      writeFileSync(
        join(fixture.proof, 'closed.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
    } finally {
      client.close();
      await owner.call('close').catch(() => {});
      await owner.kill();
      await recordManagedCleanup(setup.profile, fixture.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  60000,
);
