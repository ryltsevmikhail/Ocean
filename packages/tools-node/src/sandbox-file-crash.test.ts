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
          const fs=require('node:fs'), rename=fs.renameSync;
          fs.renameSync=(source,dest)=>{
            fs.renameSync=rename;
            rename(source,dest);
            process.kill(process.pid,'SIGKILL');
          };
        }
      `;
      return supervisor.runSandbox({ ...request, args: ['-e', race + request.args[1]] });
    },
  };
});

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains recovery content and refuses another operation after a displacement crash',
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
      ).rejects.toMatchObject({ code: 'effect_uncertain' });
      const recovery = (await readdir(join(root, 'src'))).find(
        (name) => name.startsWith('.ocean-recovery-') && !name.endsWith('.json'),
      );
      expect(recovery).toBeDefined();
      expect(JSON.parse(await readFile(join(root, 'src', recovery! + '.json'), 'utf8'))).toEqual({
        version: 1,
        path: 'src/file',
        expected: 'before',
        content: 'after',
      });
      expect(await readFile(join(root, 'src', recovery!), 'utf8')).toBe('before');
      await expect(
        sandboxFile({ root }, { op: 'write', path: 'new', expected: null, content: 'unexpected' }),
      ).rejects.toMatchObject({ code: 'effect_uncertain' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
