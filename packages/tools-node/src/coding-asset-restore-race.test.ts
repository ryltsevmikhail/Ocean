import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});
import { captureCodingAssetTree } from './coding-asset-scan.js';
import { archiveCodingAssetTree } from './coding-asset-archive.js';
import { restoreCodingAssetTree } from './coding-asset-restore.js';
it.runIf(process.platform === 'linux').each(['archive', 'output'])(
  'refuses %s replacement during quarantine materialization and preserves user data',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-restore-race-')),
      source = join(outer, 'source'),
      archive = join(outer, 'archive'),
      output = join(outer, 'out');
    fs.mkdirSync(source);
    fs.writeFileSync(join(source, 'file'), 'before');
    archiveCodingAssetTree(captureCodingAssetTree(source), archive);
    let changed = false;
    vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
      const count = actual.writeSync(...args);
      if (!changed && fs.realpathSync(`/proc/self/fd/${args[0]}`).endsWith('/tree/file')) {
        changed = true;
        if (kind === 'archive') {
          const blob = fs.readdirSync(join(archive, 'blobs'))[0]!;
          fs.writeFileSync(join(archive, 'blobs', blob), 'user');
        } else {
          fs.renameSync(output, join(outer, 'detached'));
          fs.mkdirSync(output);
          fs.writeFileSync(join(output, 'user'), 'keep');
        }
      }
      return count;
    }) as typeof fs.writeSync);
    try {
      expect(() => restoreCodingAssetTree(archive, output)).toThrow();
      expect(changed).toBe(true);
      expect(
        fs.existsSync(join(kind === 'archive' ? output : join(outer, 'detached'), '.incomplete')),
      ).toBe(true);
      expect(fs.readFileSync(join(source, 'file'), 'utf8')).toBe('before');
      if (kind === 'output') expect(fs.readFileSync(join(output, 'user'), 'utf8')).toBe('keep');
    } finally {
      vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
