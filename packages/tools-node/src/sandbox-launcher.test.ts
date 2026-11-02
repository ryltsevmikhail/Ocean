import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sandboxLauncher } from './sandbox-launcher.js';

it.each(['replacement', 'rewrite'])(
  'rejects mount source %s after preparing the bootstrap',
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-launcher-'));
    try {
      const source = join(root, 'fixture');
      await writeFile(source, 'qualified');
      const launcher = await sandboxLauncher(['--ro-bind', source, '/fixture']);
      if (change === 'replacement') await rename(source, source + '.old');
      await writeFile(source, 'replacement');
      await expect(promisify(execFile)(process.execPath, ['-e', launcher])).rejects.toMatchObject({
        stderr: expect.stringContaining('mount source changed before opening'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
