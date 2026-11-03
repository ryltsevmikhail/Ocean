import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { observeCodingFiles } from './coding-apply-observation.js';
it.each(['content', 'parent'])(
  'refuses a %s change during observation without returning matching evidence',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const root = fs.mkdtempSync(join(tmpdir(), 'ocean-observation-race-'));
    const parent = join(root, 'dir');
    fs.mkdirSync(parent);
    fs.writeFileSync(join(parent, 'file'), 'before');
    vi.mocked(fs.readSync).mockImplementationOnce(((...args: Parameters<typeof fs.readSync>) => {
      const count = actual.readSync(...args);
      if (kind === 'parent') {
        fs.renameSync(parent, join(root, 'detached'));
        fs.mkdirSync(parent);
      }
      fs.writeFileSync(join(parent, 'file'), 'user');
      return count;
    }) as typeof fs.readSync);
    try {
      expect(observeCodingFiles(root, ['dir/file'])).toEqual([
        { path: 'dir/file', kind: 'unavailable', sha256: null, mode: null },
      ]);
      expect(fs.readFileSync(join(parent, 'file'), 'utf8')).toBe('user');
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
