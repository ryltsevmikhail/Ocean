import { expect, it, vi } from 'vitest';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { ServiceConnection } from '@runnets/domain';
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
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1').each(['refresh', 'disconnect'])(
  'joins native reply loss during %s after readiness leaves the active generation',
  async (transition) => {
    const f = await managedNativeFixture(),
      root = f.workspace('a', 'hold-drop');
    const owner = child('managed-workspace-owner.test.ts', ['new', f.proof, 'close-barrier'], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (await owner.ready) as ManagedSetup,
      peer = await serviceOwnerPeer(setup.profile),
      client = await connectLocalRuntime({ profile: setup.profile });
    let job: Promise<unknown> | undefined,
      settled = false;
    try {
      await enrollManaged(setup, f, 'a', root);
      const observed = await observeManaged(setup.profile, f.proof, 'retirement-old', 'a');
      await client.roomTaskStart(await grantManaged(setup, 'a'));
      await vi.waitFor(() => expect(counter(root, 'mutation')).toBe(1), { timeout: 10000 });
      const c = ((await peer.request('service.connections', {})) as ServiceConnection[]).find(
        (v) => v.id === 'a',
      )!;
      writeFileSync(join(f.proof, 'hold-close'), 'hold exact disposable SDK cleanup');
      job = peer
        .request('service.connection-' + transition, {
          requestId: 'retirement-' + transition,
          connectionId: 'a',
          expectedVersions: {
            configRevision: c.configRevision,
            trustRevision: c.trustRevision,
            credentialRevision: c.credentialRevision,
          },
        })
        .catch(() => null)
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(
        async () =>
          expect(
            (await client.serviceConnections()).find((v) => v.id === 'a')!.configRevision,
          ).toBeGreaterThan(c.configRevision),
        { timeout: 3000 },
      );
      writeFileSync(join(root, 'call-release'), 'lose admitted response');
      await vi.waitFor(() => expect(existsSync(join(f.proof, 'retire-barrier'))).toBe(true), {
        timeout: 5000,
      });
      await owner.call('requests');
      if (transition === 'refresh') expect(settled).toBe(false);
      expect(counter(root, 'startup')).toBe(1);
      expect(counter(root, 'mutation')).toBe(1);
      writeFileSync(
        join(f.proof, 'retirement-held.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
      writeFileSync(join(f.proof, 'retire-release'), 'join actual close and whole unit cleanup');
      await job;
      await vi.waitFor(
        () =>
          expect(
            nativeJournal(setup.profile).filter((r) => r.outcome === 'uncertain'),
          ).toHaveLength(2),
        { timeout: 10000 },
      );
      expect(await managedRetired(observed, f.proof, 'retirement-old')).toBe(true);
      expect(counter(root, 'startup')).toBe(1);
      expect(counter(root, 'mutation')).toBe(1);
      writeFileSync(
        join(f.proof, 'retirement-final.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
    } finally {
      writeFileSync(join(f.proof, 'retire-release'), 'finally release exact child');
      await job;
      peer.close();
      client.close();
      await owner.call('close').catch(() => {});
      await owner.kill();
      await recordManagedCleanup(setup.profile, f.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  30000,
);
