import { expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
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
  grantManaged,
  type ManagedSetup,
} from '../../test-fixtures/managed-workspace-native.ts';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { ServiceConnection } from '@runnets/domain';
async function refresh(setup: ManagedSetup, requestId: string) {
  const peer = await serviceOwnerPeer(setup.profile);
  try {
    const c = ((await peer.request('service.connections', {})) as ServiceConnection[]).find(
      (v) => v.id === 'a',
    )!;
    return await peer.request('service.connection-refresh', {
      requestId,
      connectionId: 'a',
      expectedVersions: {
        configRevision: c.configRevision,
        trustRevision: c.trustRevision,
        credentialRevision: c.credentialRevision,
      },
    });
  } finally {
    peer.close();
  }
}
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retires repeated healthy generations and survives the default TTL beyond the former 60 second watchdog',
  async () => {
    const f = await managedNativeFixture(),
      root = f.workspace('a');
    const owner = child('managed-workspace-owner.test.ts', ['new', f.proof], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (await owner.ready) as ManagedSetup;
    try {
      await enrollManaged(setup, f, 'a', root);
      const first = await observeManaged(setup.profile, f.proof, 'refresh-first', 'a');
      await refresh(setup, 'manual-refresh');
      expect(counter(root, 'startup')).toBe(2);
      expect(await managedRetired(first, f.proof, 'refresh-first')).toBe(true);
      const second = await observeManaged(setup.profile, f.proof, 'refresh-second', 'a');
      await vi.waitFor(
        () =>
          expect(
            counter(root, 'startup') >= 3 ||
              nativeJournal(setup.profile).some((r) => r.outcome === 'uncertain'),
          ).toBe(true),
        { timeout: 70000, interval: 100 },
      );
      expect(counter(root, 'startup')).toBe(3);
      expect(await managedRetired(second, f.proof, 'refresh-second')).toBe(true);
      expect(nativeJournal(setup.profile).map((r) => r.outcome)).toEqual([
        'completed',
        'completed',
        'started',
      ]);
      expect(counter(root, 'mutation')).toBe(0);
      writeFileSync(
        join(f.proof, 'healthy-refresh-final.json'),
        JSON.stringify(nativeJournal(setup.profile), null, 2),
      );
    } finally {
      await owner.call('close').catch(() => {});
      await owner.kill();
      await recordManagedCleanup(setup.profile, f.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  80000,
);
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'drains an already admitted real call before replacing its writable generation',
  async () => {
    const f = await managedNativeFixture(),
      root = f.workspace('a', 'hold');
    const owner = child('managed-workspace-owner.test.ts', ['new', f.proof], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (await owner.ready) as ManagedSetup,
      client = await connectLocalRuntime({ profile: setup.profile });
    try {
      await enrollManaged(setup, f, 'a', root);
      const observed = await observeManaged(setup.profile, f.proof, 'drain-first', 'a');
      const input = await grantManaged(setup, 'a');
      await client.roomTaskStart(input);
      await vi.waitFor(() => expect(counter(root, 'mutation')).toBe(1), { timeout: 10000 });
      const revision = new (await import('node:sqlite')).DatabaseSync(
        join(setup.profile, 'runtime.sqlite'),
        { readOnly: true },
      );
      const before = Number(
        revision
          .prepare("SELECT config_revision AS n FROM ocean_service_connections WHERE id='a'")
          .get()?.['n'],
      );
      const job = refresh(setup, 'drain-refresh').then(
        () => true,
        () => false,
      );
      await vi.waitFor(
        () =>
          expect(
            Number(
              revision
                .prepare("SELECT config_revision AS n FROM ocean_service_connections WHERE id='a'")
                .get()?.['n'],
            ),
          ).toBeGreaterThan(before),
        { timeout: 3000 },
      );
      revision.close();
      await owner.call('requests'); // Joins a later owner event-loop turn after refresh has begun.
      expect(nativeJournal(setup.profile).find((r) => r.tool === 'write')?.outcome).toBe('started');
      writeFileSync(join(root, 'call-release'), 'finish admitted call');
      expect(await job).toBe(true);
      expect(counter(root, 'startup')).toBe(2);
      expect(counter(root, 'mutation')).toBe(1);
      expect(await managedRetired(observed, f.proof, 'drain-first')).toBe(true);
      expect(nativeJournal(setup.profile).map((r) => r.outcome)).toEqual([
        'completed',
        'completed',
        'started',
      ]);
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
