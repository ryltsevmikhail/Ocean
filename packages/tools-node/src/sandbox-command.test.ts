import type { CodingTestPreset } from '@runnets/domain';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { type SandboxCommandEvidence, createSandboxBackend } from './sandbox-probe.js';

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'binds exact presets and refuses passing evidence when a successful test edits source',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-evidence-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      await writeFile(join(root, 'source'), 'before');
      const preset: CodingTestPreset = {
        id: 'test',
        program: '/toolchain/node',
        args: ['-e', "require('node:fs').writeFileSync('/workspace/source','after')"],
        cwd: '.',
      };
      const backend = await createSandboxBackend({ root }, [preset], () =>
        readFile(join(root, 'source'), 'utf8'),
      );
      await expect(
        backend.command(preset.program, [], '.', new AbortController().signal),
      ).rejects.toMatchObject({ code: 'preset_denied' });
      const result = await backend.command(
        preset.program,
        preset.args,
        '.',
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
      const evidence = JSON.parse(result.output) as SandboxCommandEvidence;
      expect(evidence).toMatchObject({
        exitCode: 0,
        cleanupConfirmed: true,
        beforeTreeHash: 'before',
        afterTreeHash: 'after',
        sourceUnchanged: false,
        dependenciesUnchanged: true,
      });
      expect(evidence.invocationHash).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.dependencyHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
