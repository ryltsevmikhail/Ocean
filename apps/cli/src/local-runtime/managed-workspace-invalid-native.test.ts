import { expect, it } from 'vitest';
import { writeFileSync, linkSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { serviceOwnerPeer } from '../../test-fixtures/service-owner-peer.js';
import {
  managedNativeFixture,
  nativeJournal,
  counter,
  recordManagedCleanup,
  enrollManaged,
  type ManagedSetup,
} from '../../test-fixtures/managed-workspace-native.ts';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'refuses symlinks, hardlinks, missing roots and unbound legacy enrollment before JavaScript startup',
  async () => {
    const f = await managedNativeFixture(),
      good = f.workspace('positive'),
      symbolic = f.workspace('symbolic'),
      hard = f.workspace('hard');
    const outside = join(f.proof, 'outside');
    writeFileSync(outside, 'synthetic');
    symlinkSync(outside, join(symbolic, 'alias'));
    linkSync(outside, join(hard, 'alias'));
    const owner = child('managed-workspace-owner.test.ts', ['new', f.proof], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (await owner.ready) as ManagedSetup;
    try {
      await enrollManaged(setup, f, 'positive', good);
      expect(counter(good, 'startup')).toBe(1);
      for (const [id, root] of [
        ['symbolic', symbolic],
        ['hard', hard],
        ['missing', join(f.proof, 'missing')],
      ] as const) {
        await expect(enrollManaged(setup, f, id, root)).rejects.toThrow();
        expect(counter(root, 'startup')).toBe(0);
      }
      const peer = await serviceOwnerPeer(setup.profile);
      try {
        const saved = (await peer.request('service.connection-set', {
          requestId: 'legacy',
          connectionId: 'legacy',
          expectedVersions: null,
          name: 'legacy',
          configuration: { kind: 'stdio', executable: f.artifact, sha256: f.digest, args: [] },
          metadataPermission: 'allow',
        })) as {
          result: { configRevision: number; trustRevision: number; credentialRevision: number };
        };
        await expect(
          peer.request('service.connection-refresh', {
            requestId: 'refresh-legacy',
            connectionId: 'legacy',
            expectedVersions: {
              configRevision: saved.result.configRevision,
              trustRevision: saved.result.trustRevision,
              credentialRevision: saved.result.credentialRevision,
            },
          }),
        ).rejects.toThrow();
      } finally {
        peer.close();
      }
      expect(nativeJournal(setup.profile)).toHaveLength(1);
    } finally {
      await owner.call('close').catch(() => {});
      await owner.kill();
      await recordManagedCleanup(setup.profile, f.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  30000,
);
