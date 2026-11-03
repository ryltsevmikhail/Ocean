import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type * as Supervisor from './sandbox-supervision.js';
import { createSandboxBackend } from './sandbox-probe.js';
vi.mock('./sandbox-supervision.js', async (original) => {
  const supervisor = await original<typeof Supervisor>();
  return {
    ...supervisor,
    async runSandbox(request: Supervisor.SandboxRequest) {
      const result = await supervisor.runSandbox(request);
      return request.args[1] === 'process.exit(0)' || request.stdin !== undefined
        ? { ...result, cleanupConfirmed: false }
        : result;
    },
  };
});
it
  .runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')
  .each(['command', 'file'])(
  'holds subsequent reads writes and commands after unconfirmed %s cleanup',
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), 'ocean-hold-'));
    try {
      await writeFile(join(root, '.git'), 'synthetic');
      const preset = {
        id: 'test',
        program: '/toolchain/node',
        args: ['-e', 'process.exit(0)'],
        cwd: '.',
      };
      const backend = await createSandboxBackend({ root }, [preset], async () => 'same');
      const signal = new AbortController().signal;
      if (operation === 'file')
        await expect(backend.read('source')).rejects.toMatchObject({ code: 'effect_uncertain' });
      else
        expect(await backend.command(preset.program, preset.args, '.', signal)).toMatchObject({
          uncertain: true,
          isError: true,
        });
      await expect(backend.read('source')).rejects.toMatchObject({ code: 'effect_uncertain' });
      await expect(backend.write('source', 'new', null)).rejects.toMatchObject({
        code: 'effect_uncertain',
      });
      await expect(backend.command(preset.program, preset.args, '.', signal)).rejects.toMatchObject(
        { code: 'effect_uncertain' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
