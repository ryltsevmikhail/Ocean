import { graphFixture } from '../test-fixtures/coding-recovery-graph.test.js';
import { captureCodingRecoveryAssets } from './coding-recovery-graph.js';
import { archiveCodingAssetTree } from './coding-asset-archive.js';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
  };
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

async function changeMountWhen(path: string, replaced: () => boolean) {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const value = actual.readFileSync(...args),
      name = String(args[0]);
    if (replaced() && name.startsWith('/proc/self/fdinfo/') && typeof value === 'string') {
      const target = actual.realpathSync('/proc/self/fd/' + name.split('/').at(-1));
      if (target === path || target.startsWith(path + '/'))
        return value.replace(/^mnt_id:\s+\d+$/m, 'mnt_id:\t999999999');
    }
    return value;
  }) as typeof fs.readFileSync);
  return actual;
}
it.each(['initial', 'archive'] as const)(
  'refuses the root mount replaced after %s metadata preflight before body reads',
  async (kind) => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-preflight-mount-')),
      root = join(outer, 'source');
    fs.mkdirSync(root);
    fs.writeFileSync(join(root, 'file'), 'x');
    const issued = kind === 'archive' ? captureCodingAssetFiles(root, ['file']) : null;
    let replaced = false;
    const actual = await changeMountWhen(root, () => replaced);
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      const current = actual.realpathSync('/proc/self/fd/' + fd);
      actual.closeSync(fd);
      if (current === root) replaced = true;
    });
    vi.mocked(fs.readSync).mockClear();
    try {
      let error: unknown;
      try {
        if (issued) archiveCodingAssetTree(issued, join(outer, 'archive'));
        else captureCodingAssetFiles(root, ['file']);
      } catch (thrown) {
        error = thrown;
      }
      expect(replaced).toBe(true);
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(error).toEqual(Error('stale_coding_asset'));
    } finally {
      vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
      vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
it('refuses a same-inode mount substitution of the managed subtree after the graph consumer', async () => {
  const f = graphFixture();
  let replaced = false;
  const actual = await changeMountWhen(f.managed, () => replaced);
  try {
    f.scoped(f.add('one', 0, 2));
    await expect(
      captureCodingRecoveryAssets(f.inventory(), f.managed, async () => {
        replaced = true;
      }),
    ).rejects.toThrow('stale_coding_asset');
    expect(replaced).toBe(true);
  } finally {
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    f.close();
  }
});
