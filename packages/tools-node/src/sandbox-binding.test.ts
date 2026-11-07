import type { CodingTestPreset } from '@runnets/domain';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createSandboxBackend } from './sandbox-probe.js';

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'refuses toolchain mutation after authority verification during snapshot capture',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-binding-'));
    const fixture = await mkdtemp(join(tmpdir(), 'ocean-toolchain-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      const source = join(fixture, 'pnpm');
      await writeFile(source, '#!/usr/bin/sh\necho qualified\n', { mode: 0o755 });
      const preset: CodingTestPreset = {
        id: 'test',
        program: '/toolchain/pnpm/bin/pnpm',
        args: [],
        cwd: '.',
      };
      const backend = await createSandboxBackend(
        { root, mounts: [{ source, target: preset.program }] },
        [preset],
        async () => {
          await writeFile(source, '#!/usr/bin/sh\necho UNQUALIFIED\n');
          return 'unchanged-source';
        },
      );
      await expect(
        backend.command(preset.program, [], '.', new AbortController().signal),
      ).rejects.toThrow('qualified sandbox input changed');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
