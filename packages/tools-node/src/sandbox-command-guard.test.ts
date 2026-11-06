import type * as Supervision from './sandbox-supervision.js';
import { expect, it, vi } from 'vitest';
import { createSandboxBackend } from './sandbox-probe.js';
import { assertCodingInspection } from './coding-git.js';
const effects = vi.hoisted(() => ({ sends: 0 }));
vi.mock('./sandbox-supervision.js', async (original) => {
  const actual = await original<typeof Supervision>();
  return {
    ...actual,
    runSandbox: async (r: Parameters<typeof actual.runSandbox>[0]) => {
      await r.guard?.prepare?.();
      if (r.guard && !r.guard.authorize()) throw Error('dispatch denied');
      if (r.args?.[0] === 'fixture-command') effects.sends++;
      return { cleanupConfirmed: true, reason: 'exit', exitCode: 0, truncated: false, output: '' };
    },
  };
});
it.each(['valid', 'before', 'after'] as const)(
  'forwards current per-command snapshot inspection without consuming dispatch: %s',
  async (mode) => {
    effects.sends = 0;
    let allowed = true,
      reads = 0,
      dispatches = 0;
    const preset = {
      id: 'test',
      program: '/toolchain/node',
      args: ['fixture-command'],
      cwd: '.' as const,
    };
    const backend = await createSandboxBackend({ root: '/synthetic' }, [preset], async (guard) => {
      assertCodingInspection(guard);
      reads++;
      return 'tree';
    });
    if (mode === 'before') allowed = false;
    const guard = {
      inspect: () => allowed,
      authorize: () => {
        dispatches++;
        if (!allowed || dispatches > 1) return false;
        if (mode === 'after') allowed = false;
        return true;
      },
    };
    const call = backend.command(
      preset.program,
      preset.args,
      '.',
      new AbortController().signal,
      guard,
    );
    if (mode === 'valid') {
      expect(await call).toMatchObject({ isError: false });
      expect(reads).toBe(2);
    } else {
      await expect(call).rejects.toThrow();
      expect(reads).toBe(mode === 'before' ? 0 : 1);
    }
    expect(effects.sends).toBe(mode === 'before' ? 0 : 1);
    expect(dispatches).toBe(mode === 'before' ? 0 : 1);
  },
);
