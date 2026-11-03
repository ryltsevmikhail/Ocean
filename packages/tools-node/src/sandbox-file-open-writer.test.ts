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
          const fs=require('node:fs'), rename=fs.renameSync,link=fs.linkSync;
          let original;
          fs.renameSync=(source,dest)=>{
            original=fs.openSync(source,'r+');
            return rename(source,dest);
          };
          fs.linkSync=(source,dest)=>{
            link(source,dest);
            fs.writeSync(original,'late owner edit',0,'utf8');
            fs.fsyncSync(original);fs.closeSync(original);
          };
        }
      `;
      return supervisor.runSandbox({ ...request, args: ['-e', race + request.args[1]] });
    },
  };
});

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains a late write through an open descriptor after installation',
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
      expect(await readFile(join(root, 'src/file'), 'utf8')).toBe('after');
      const recovery = (await readdir(join(root, 'src'))).find(
        (name) => name.startsWith('.ocean-recovery-') && !name.endsWith('.json'),
      );
      expect(recovery).toBeDefined();
      expect(await readFile(join(root, 'src', recovery!), 'utf8')).toBe('late owner edit');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
