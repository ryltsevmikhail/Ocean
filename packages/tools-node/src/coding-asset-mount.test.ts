import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});
import { captureCodingAssetTree } from './coding-asset-scan.js';
it.runIf(process.platform === 'linux')(
  'refuses an unplanned child mount before reading its file data',
  async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const root = fs.mkdtempSync(join(tmpdir(), 'ocean-asset-mount-')),
      child = join(root, 'child');
    fs.mkdirSync(child);
    fs.writeFileSync(join(child, 'private'), 'do not read');
    vi.mocked(fs.readFileSync).mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const result = actual.readFileSync(...args),
        path = String(args[0]);
      if (
        path.startsWith('/proc/self/fdinfo/') &&
        actual.realpathSync('/proc/self/fd/' + path.split('/').at(-1)) === child &&
        typeof result === 'string'
      )
        return result.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t999999999');
      return result;
    }) as typeof fs.readFileSync);
    vi.mocked(fs.readSync).mockClear();
    try {
      expect(() => captureCodingAssetTree(root)).toThrow('unsupported_coding_asset');
      expect(fs.readSync).not.toHaveBeenCalled();
    } finally {
      vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
