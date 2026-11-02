import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSandbox } from './sandbox-supervision.js';

const faults = vi.hoisted(() => ({ events: [] as (string | Error)[] }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      const next = String(args[0]).endsWith('/cgroup.events') ? faults.events.shift() : undefined;
      if (next instanceof Error) return Promise.reject(next);
      return next === undefined ? fs.readFile(...args) : Promise.resolve(next);
    },
  };
});

describe.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'supervised worker observation faults',
  () => {
    afterEach(() => {
      faults.events.length = 0;
    });
    it.each(['populated 0\n', 'frozen 0\n', 'populated 1\npopulated 0\n'])(
      'withholds dispatch on invalid initial observation %j',
      async (events) => {
        const root = await mkdtemp(join(tmpdir(), 'ocean-observe-'));
        try {
          await writeFile(join(root, '.git'), 'synthetic-git-pointer');
          faults.events.push(events);
          const result = await runSandbox({
            root,
            program: '/toolchain/node',
            args: ['-e', "require('node:fs').writeFileSync('/workspace/dispatched','x')"],
          });
          expect(result.reason).toBe('unavailable');
          expect(result.cleanupConfirmed).toBe(false);
          await expect(readFile(join(root, 'dispatched'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
    it.each([new Error('observation lost'), 'populated 1\n', 'populated 0\npopulated 1\n'])(
      'retains uncertainty on invalid final observation %s',
      async (events) => {
        const root = await mkdtemp(join(tmpdir(), 'ocean-observe-'));
        try {
          await writeFile(join(root, '.git'), 'synthetic-git-pointer');
          faults.events.push('populated 1\n', events);
          const result = await runSandbox({ root, program: '/toolchain/node', args: ['-e', ''] });
          expect(result.exitCode).toBe(0);
          expect(result.cleanupConfirmed).toBe(false);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);
