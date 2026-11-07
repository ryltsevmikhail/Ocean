import type * as FsIo from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const barrier = vi.hoisted(() => ({
  hold: false,
  enter: () => {},
  wait: Promise.resolve(),
  opens: 0,
  directory: undefined as FsIo.FileHandle | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const io = await original<typeof FsIo>();
  return {
    ...io,
    open: async (...args: Parameters<typeof io.open>) => {
      barrier.opens++;
      const file = await io.open(...args);
      barrier.directory = file;
      return file;
    },
    opendir: async (...args: Parameters<typeof io.opendir>) => {
      if (barrier.hold) {
        barrier.enter();
        await barrier.wait;
      }
      return io.opendir(...args);
    },
  };
});
import { openManagedWorkspace } from './managed-workspace.js';
it('keeps asynchronous inventory responsive and owns held descriptors until cancelled I/O actually unwinds', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'managed-async-'));
  let release!: () => void, enter!: () => void;
  barrier.wait = new Promise<void>((r) => {
    release = r;
  });
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  barrier.enter = enter;
  barrier.hold = true;
  const ac = new AbortController();
  let ended = false;
  const opening = openManagedWorkspace(root, ac.signal, [], Date.now() + 5000).finally(() => {
    ended = true;
  });
  const refused = expect(opening).rejects.toThrow();
  try {
    await entered;
    await new Promise<void>((r) => setImmediate(r));
    expect(ended).toBe(false);
    const held = barrier.directory!,
      opens = barrier.opens;
    expect((await held.stat()).isDirectory()).toBe(true);
    ac.abort();
    await new Promise<void>((r) => setImmediate(r));
    expect(ended).toBe(false);
    expect(barrier.opens).toBe(opens);
    release();
    await refused;
    await expect(held.stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect(barrier.opens).toBe(opens);
  } finally {
    barrier.hold = false;
    release();
    await refused;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
