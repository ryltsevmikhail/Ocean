import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { captureCodingAssetTree } from './coding-asset-scan.js';
it.runIf(process.platform === 'linux').each(['content', 'parent'])(
  'refuses a %s replacement during asset hashing',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const root = fs.mkdtempSync(join(tmpdir(), 'ocean-asset-race-')),
      parent = join(root, 'dir');
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
      expect(() => captureCodingAssetTree(root)).toThrow('stale_coding_asset');
      expect(fs.readFileSync(join(parent, 'file'), 'utf8')).toBe('user');
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
