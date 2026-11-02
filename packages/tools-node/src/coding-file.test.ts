import { expect, it, vi } from 'vitest';
import { lstat, open, realpath } from 'node:fs/promises';
import { codingFile } from './coding-file.js';
vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), open: vi.fn(), realpath: vi.fn() }));
it.each([0, 1])('bounds reads even when a file grows after its initial size %s', async (size) => {
  vi.resetAllMocks();
  const stat = {
    size,
    ino: 1,
    nlink: 1,
    mtimeMs: 1,
    mode: 0o600,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
  vi.mocked(lstat).mockResolvedValue(stat as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(realpath).mockResolvedValue('/worktree/growing.txt');
  const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
    buffer.fill(120, offset, offset + length);
    return { bytesRead: length, buffer };
  });
  const readFile = vi.fn(async () => Buffer.alloc(10));
  const file = { fd: 42, stat: async () => stat, read, readFile, close: async () => {} };
  vi.mocked(open).mockResolvedValue(file as unknown as Awaited<ReturnType<typeof open>>);
  await expect(codingFile('/worktree', 'growing.txt')).rejects.toThrow('stale_capture');
  expect(readFile).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[2]).toBe(size + 1);
  expect(read.mock.calls[0]?.[0].length).toBe(size + 1);
});
