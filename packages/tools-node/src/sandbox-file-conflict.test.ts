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
            fs.writeFileSync(source,'concurrent owner edit');
            return rename(source,dest);
          };
        }
      `;
      return supervisor.runSandbox({ ...request, args: ['-e', race + request.args[1]] });
    },
  };
});

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'preserves a concurrent edit encountered at the atomic displacement',
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
      expect(await readFile(join(root, 'src/file'), 'utf8')).toBe('concurrent owner edit');
      expect(await readdir(join(root, 'src'))).toEqual(['file']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
