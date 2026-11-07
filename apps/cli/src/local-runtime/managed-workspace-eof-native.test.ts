import { expect, it, vi } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
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
  'bounds a real native early metadata EOF and retains its lost lifetime without replay',
  async () => {
    const f = await managedNativeFixture(),
      root = f.workspace('a', 'early-close');
    const owner = child('managed-workspace-owner.test.ts', ['new', f.proof], {
      ...process.env,
      DEEPSEEK_API_KEY: 'synthetic-managed-workspace',
    });
    const setup = (await owner.ready) as ManagedSetup;
    try {
      const started = performance.now();
      const enrolling = enrollManaged(setup, f, 'a', root).then(
        () => false,
        () => true,
      );
      await vi.waitFor(() => expect(existsSync(join(root, 'close-ready'))).toBe(true), {
        timeout: 5000,
      });
      const observed = await observeManaged(setup.profile, f.proof, 'early-eof', 'a');
      writeFileSync(join(root, 'close-release'), 'owned server EOF');
      expect(await enrolling).toBe(true);
      expect(await managedRetired(observed, f.proof, 'early-eof')).toBe(true);
      expect(performance.now() - started).toBeLessThan(15000);
      await vi.waitFor(
        () => expect(nativeJournal(setup.profile).map((r) => r.outcome)).toEqual(['uncertain']),
        { timeout: 5000 },
      );
      expect(counter(root, 'startup')).toBe(1);
      expect(counter(root, 'mutation')).toBe(0);
      await expect(enrollManaged(setup, f, 'same', root)).rejects.toThrow();
      expect(counter(root, 'startup')).toBe(1);
      writeFileSync(
        join(f.proof, 'early-eof-final.json'),
        JSON.stringify(
          {
            rows: nativeJournal(setup.profile),
            startup: counter(root, 'startup'),
            mutations: counter(root, 'mutation'),
          },
          null,
          2,
        ),
      );
    } finally {
      writeFileSync(join(root, 'close-release'), 'finally release');
      await owner.call('close').catch(() => {});
      await owner.kill();
      await recordManagedCleanup(setup.profile, f.proof);
      rmSync(setup.root, { recursive: true, force: true });
    }
  },
  30000,
);
