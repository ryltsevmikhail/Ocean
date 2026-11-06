import { expect, it, vi } from 'vitest';
import { existsSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import {
  managedNativeFixture,
  nativeJournal,
  counter,
  recordManagedCleanup,
  enrollManaged,
  type ManagedSetup,
} from '../../test-fixtures/managed-workspace-native.ts';
it.runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1').each(['replace', 'pin', 'crash'] as const)(
  'holds durable launch authority before SDK spawn and fences a %s race',
  async (mode) => {
    const f = await managedNativeFixture();
    const a = f.workspace('a'),
      b = f.workspace('b');
    const env = { ...process.env, DEEPSEEK_API_KEY: 'synthetic-managed-workspace' };
    let owner = child('managed-workspace-owner.test.ts', ['new', f.proof, 'barrier'], env);
    const setup = (await owner.ready) as ManagedSetup;
    const pending = enrollManaged(setup, f, 'a', a).then(
      () => 'started',
      (e: Error) => e.message,
    );
    try {
      await vi.waitFor(() => expect(existsSync(join(f.proof, 'pre-spawn-barrier'))).toBe(true), {
        timeout: 10000,
      });
      expect(counter(a, 'startup')).toBe(0);
      const committed = nativeJournal(setup.profile);
      expect(committed).toMatchObject([{ task_run_id: '\0managed-stdio/v1', outcome: 'started' }]);
      writeFileSync(join(f.proof, 'pre-spawn-journal.json'), JSON.stringify(committed, null, 2));
      if (mode === 'crash') {
        await owner.kill();
        expect(await pending).not.toBe('started');
        owner = child('managed-workspace-owner.test.ts', ['recover', f.proof], env);
        await owner.ready;
        expect(nativeJournal(setup.profile)[0]?.['outcome']).toBe('uncertain');
        expect(counter(a, 'startup')).toBe(0);
        await enrollManaged(setup, f, 'b', b);
        expect(counter(b, 'startup')).toBe(1);
      } else {
        if (mode === 'replace') {
          renameSync(a, a + '-old');
          f.workspace('a');
        } else writeFileSync(f.artifact, 'throw Error("replacement must never execute")');
        writeFileSync(join(f.proof, 'spawn-release'), 'go');
        expect(await pending).not.toBe('started');
        expect(counter(a, 'startup')).toBe(0);
        expect(counter(a + '-old', 'startup')).toBe(0);
        expect(nativeJournal(setup.profile)[0]?.['outcome']).toBe('uncertain');
      }
      writeFileSync(
        join(f.proof, 'race-final.json'),
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
