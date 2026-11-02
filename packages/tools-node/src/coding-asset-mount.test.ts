import { archiveCodingAssetTree } from './coding-asset-archive.js';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});
import { captureCodingAssetFiles, captureCodingAssetTree } from './coding-asset-scan.js';
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
it('refuses a rebound selected file mount before copying the first byte into a private output', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs'),
    outer = fs.mkdtempSync(join(tmpdir(), 'ocean-selected-mount-'));
  const root = join(outer, 'source'),
    archive = join(outer, 'out'),
    path = join(root, 'file');
  fs.mkdirSync(root);
  fs.writeFileSync(path, 'synthetic');
  try {
    const capture = captureCodingAssetFiles(root, ['file']);
    const copying = () => actual.existsSync(join(archive, '.incomplete'));
    let bodyReads = 0;
    vi.mocked(fs.readFileSync).mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      const value = actual.readFileSync(...args),
        name = String(args[0]);
      if (
        copying() &&
        name.startsWith('/proc/self/fdinfo/') &&
        actual.realpathSync('/proc/self/fd/' + name.split('/').at(-1)) === path &&
        typeof value === 'string'
      )
        return value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t999999999');
      return value;
    }) as typeof fs.readFileSync);
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (copying() && actual.realpathSync('/proc/self/fd/' + args[0]) === path) bodyReads++;
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    expect(() => archiveCodingAssetTree(capture, archive)).toThrow();
    expect(bodyReads).toBe(0);
    expect(copying()).toBe(true);
  } finally {
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
