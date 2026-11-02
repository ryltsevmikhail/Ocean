import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { createNativeBackend } from './native.js';
vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  realpath: vi.fn(),
  open: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  link: vi.fn(),
}));
function stat(file: boolean): Stats {
  return {
    isDirectory: () => !file,
    isFile: () => file,
    isSymbolicLink: () => false,
    nlink: 1,
  } as Stats;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(realpath).mockResolvedValue('/workspace');
  vi.mocked(lstat).mockResolvedValue(stat(false));
});
it('rejects a nonregular file before an open can block on a FIFO', async () => {
  const backend = await createNativeBackend('/workspace');
  await expect(backend.read('fifo')).rejects.toThrow('regular');
  expect(open).not.toHaveBeenCalled();
});
it('opens regular files with nonblocking and no-follow to reject races to a FIFO or symlink', async () => {
  const backend = await createNativeBackend('/workspace');
  vi.mocked(lstat).mockResolvedValue(stat(true));
  vi.mocked(open).mockRejectedValue(new Error('simulated open'));
  await expect(backend.read('source.ts')).rejects.toThrow('simulated open');
  expect(open).toHaveBeenCalledWith(
    '/workspace/source.ts',
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
});
