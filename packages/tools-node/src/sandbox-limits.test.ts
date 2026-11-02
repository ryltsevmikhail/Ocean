import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runSandbox } from './sandbox-supervision.js';

it.each([NaN, -1, 0, Infinity, 1.5])(
  'refuses invalid retained output limit %s before dispatch',
  async (outputBytes) => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-limits-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      await expect(
        runSandbox({ root, outputBytes, program: '/toolchain/node', args: [] }),
      ).rejects.toThrow('invalid sandbox output');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
