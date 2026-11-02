import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { sandboxFile } from './sandbox-files.js';
import type * as Supervisor from './sandbox-supervision.js';

// Exchange the parent immediately after staging the replacement but before installation.
vi.mock('./sandbox-supervision.js', async (original) => {
  const supervisor = await original<typeof Supervisor>();
  return {
    ...supervisor,
    runSandbox(request: Supervisor.SandboxRequest) {
      const race = `
        {
          const fs=require('node:fs'), sync=fs.fsyncSync;
          fs.fsyncSync=function(fd) {
            sync(fd);
            fs.fsyncSync=sync;
            fs.renameSync('src','moved');
            fs.mkdirSync('src');
            fs.writeFileSync('src/file','before');
            const temp=fs.readdirSync('moved').find(name=>name.endsWith('.tmp'));
            fs.writeFileSync('src/'+temp,'unrelated');
          };
        }
      `;
      return supervisor.runSandbox({ ...request, args: ['-e', race + request.args[1]] });
    },
  };
});

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'refuses a swapped parent and cleans the temp using the pinned directory',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-race-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src/file'), 'before');
      await expect(
        sandboxFile(
          { root },
          { op: 'write', path: 'src/file', expected: 'before', content: 'after' },
        ),
      ).rejects.toThrow('refused');
      expect(await readFile(join(root, 'src/file'), 'utf8')).toBe('before');
      expect(await readdir(join(root, 'moved'))).toEqual(['file']);
      expect(await readdir(join(root, 'src'))).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
