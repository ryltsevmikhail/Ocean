import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sandboxLauncher } from './sandbox-launcher.js';

it('rejects a mount source exchanged after preparing the bootstrap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocean-launcher-'));
  try {
    const source = join(root, 'fixture');
    await writeFile(source, 'qualified');
    const launcher = await sandboxLauncher(['--ro-bind', source, '/fixture']);
    await rename(source, source + '.old');
    await writeFile(source, 'replacement');
    await expect(promisify(execFile)(process.execPath, ['-e', launcher])).rejects.toMatchObject({
      stderr: expect.stringContaining('mount source changed before opening'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
