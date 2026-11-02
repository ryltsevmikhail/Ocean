import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});
import { gitObjectStorage } from './coding-git-storage.js';
it.runIf(process.platform === 'linux').each(['same', 'mounted-file', 'mounted-directory'])(
  'validates %s object layout using metadata without reading object bodies',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-object-layout-'));
    fs.mkdirSync(join(outer, 'ab'));
    const file = join(outer, 'ab', 'c'.repeat(38));
    fs.writeFileSync(file, 'opaque synthetic object body');
    const fd = fs.openSync(outer, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    vi.mocked(fs.readSync).mockClear();
    vi.mocked(fs.readFileSync).mockImplementation(((
      path: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (typeof path === 'string' && path.startsWith('/proc/self/fdinfo/')) {
        const descriptor = Number(path.slice('/proc/self/fdinfo/'.length));
        const canonical = actual.realpathSync('/proc/self/fd/' + descriptor);
        if (
          (kind === 'mounted-file' && canonical === file) ||
          (kind === 'mounted-directory' && canonical === join(outer, 'ab'))
        )
          return 'mnt_id:\t99999999\n';
      }
      return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
    }) as typeof fs.readFileSync);
    try {
      if (kind === 'same') expect(gitObjectStorage(fd, outer, 40)).toMatch(/^[a-f0-9]{64}$/);
      else expect(() => gitObjectStorage(fd, outer, 40)).toThrow('unsupported_coding_git_storage');
      expect(fs.readSync).not.toHaveBeenCalled();
    } finally {
      vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
      fs.closeSync(fd);
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
