import { expect, it, vi } from 'vitest';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
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
  'admits two physical sibling sessions and overlapping real calls while keeping the same workspace serialized',
  async () => {
    const f = await managedNativeFixture();
    const a = f.workspace('a', 'hold'),
      b = f.workspace('b', 'hold');
    const owner = child('managed-workspace-owner.test.ts', ['new', f.proof], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (await owner.ready) as ManagedSetup;
    const client = await connectLocalRuntime({ profile: setup.profile });
    try {
      await enrollManaged(setup, f, 'a', a);
      await enrollManaged(setup, f, 'b', b);
      // Keep directory entries stable while each sibling's asynchronous proof is collected.
      for (const root of [a, b])
        for (const name of ['received', 'mutation']) writeFileSync(join(root, name), '');
      expect(
        [a, b].flatMap((root) => [counter(root, 'received'), counter(root, 'mutation')]),
      ).toEqual([0, 0, 0, 0]);
      const observedA = await observeManaged(setup.profile, f.proof, 'concurrent-a', 'a');
      const observedB = await observeManaged(setup.profile, f.proof, 'concurrent-b', 'b');
      const inputA = await grantManaged(setup, 'a'),
        inputB = await grantManaged(setup, 'b', setup.bRoom);
      await client.roomTaskStart(inputA);
      await vi.waitFor(
        () => {
          expect([counter(a, 'received'), counter(a, 'mutation')]).toEqual([1, 1]);
          expect(nativeJournal(setup.profile).find((r) => r.tool === 'write')).toMatchObject({
            outcome: 'started',
            admission: { binding: { connectionId: 'a' } },
          });
        },
        { timeout: 10000 },
      );
      writeFileSync(
        join(f.proof, 'concurrent-a-held-before-b.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
      await client.roomTaskStart(inputB);
      await vi.waitFor(
        () => expect([counter(a, 'mutation'), counter(b, 'mutation')]).toEqual([1, 1]),
        { timeout: 10000 },
      );
      expect([counter(a, 'received'), counter(b, 'received')]).toEqual([1, 1]);
      const inFlight = nativeJournal(setup.profile);
      expect(inFlight).toHaveLength(4);
      expect(inFlight.every((r) => r['outcome'] === 'started')).toBe(true);
      writeFileSync(join(f.proof, 'concurrent-started.json'), JSON.stringify(inFlight, null, 2));
      expect([a, b].some((root) => existsSync(join(root, 'call-release')))).toBe(false);
      for (const id of ['a', 'b']) {
        const live = await observeManaged(setup.profile, f.proof, 'concurrent-' + id + '-held', id);
        expect(live.fields['cgroup.events']).toContain('populated 1');
        expect(live.pids.length).toBeGreaterThan(0);
      }
      await expect(enrollManaged(setup, f, 'same', a)).rejects.toThrow();
      expect(counter(a, 'startup')).toBe(1);
      writeFileSync(join(a, 'call-release'), 'go');
      writeFileSync(join(b, 'call-release'), 'go');
      await vi.waitFor(
        () =>
          expect(
            nativeJournal(setup.profile).filter((r) => r['outcome'] === 'completed'),
          ).toHaveLength(2),
        { timeout: 10000 },
      );
      await owner.call('close');
      expect(await managedRetired(observedA, f.proof, 'concurrent-a')).toBe(true);
      expect(await managedRetired(observedB, f.proof, 'concurrent-b')).toBe(true);
      expect(nativeJournal(setup.profile).every((r) => r['outcome'] === 'completed')).toBe(true);
      writeFileSync(
        join(f.proof, 'concurrent-closed.json'),
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
  60000,
);
