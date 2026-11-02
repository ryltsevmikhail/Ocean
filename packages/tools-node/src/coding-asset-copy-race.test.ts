import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});
import { captureCodingAssetTree } from './coding-asset-scan.js';
import { archiveCodingAssetTree, verifyCodingAssetArchive } from './coding-asset-archive.js';
it.runIf(process.platform === 'linux').each(['source', 'output'])(
  'refuses %s replacement during archive copy without deleting user data',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const root = fs.mkdtempSync(join(tmpdir(), 'ocean-copy-race-')),
      source = join(root, 'source'),
      output = join(root, 'archive');
    fs.mkdirSync(source);
    fs.writeFileSync(join(source, 'file'), 'before');
    const capture = captureCodingAssetTree(source);
    let changed = false;
    vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      const count = actual.writeSync(...args);
      if (!changed && fs.realpathSync(`/proc/self/fd/${args[0]}`).includes('/blobs/')) {
        changed = true;
        if (kind === 'source') fs.writeFileSync(join(source, 'file'), 'user');
        else {
          fs.renameSync(output, join(root, 'detached'));
          fs.mkdirSync(output);
          fs.writeFileSync(join(output, 'user'), 'keep');
        }
      }
      return count;
    }) as typeof fs.writeSync);
    try {
      expect(() => archiveCodingAssetTree(capture, output)).toThrow('stale_coding_asset');
      expect(changed).toBe(true);
      const retained = kind === 'source' ? output : join(root, 'detached');
      expect(fs.existsSync(join(retained, '.incomplete'))).toBe(true);
      expect(() => verifyCodingAssetArchive(retained)).toThrow();
      expect(
        fs.readFileSync(kind === 'source' ? join(source, 'file') : join(output, 'user'), 'utf8'),
      ).toBe(kind === 'source' ? 'user' : 'keep');
    } finally {
      vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
