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
          const fs=require('node:fs'), link=fs.linkSync;
          fs.linkSync=(source,dest)=>{
            link(source,dest);
            process.kill(process.pid,'SIGKILL');
          };
        }
      `;
      return supervisor.runSandbox({ ...request, args: ['-e', race + request.args[1]] });
    },
  };
});

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains creation intent after interruption immediately following installation',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-race-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      await mkdir(join(root, 'src'));

      await expect(
        sandboxFile({ root }, { op: 'write', path: 'src/file', expected: null, content: 'after' }),
      ).rejects.toMatchObject({ code: 'effect_uncertain' });
      const intent = (await readdir(join(root, 'src'))).find((name) => name.endsWith('.json'));
      expect(intent).toBeDefined();
      expect(JSON.parse(await readFile(join(root, 'src', intent!), 'utf8'))).toEqual({
        version: 1,
        path: 'src/file',
        expected: null,
        content: 'after',
      });
      expect(await readFile(join(root, 'src/file'), 'utf8')).toBe('after');
      await expect(
        sandboxFile({ root }, { op: 'write', path: 'new', expected: null, content: 'unexpected' }),
      ).rejects.toMatchObject({ code: 'effect_uncertain' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
