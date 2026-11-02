import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as assets from './index.js';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) };
});
function fixture(work: (root: string, outer: string) => void) {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-selection-')),
    root = join(outer, 'source');
  fs.mkdirSync(root);
  try {
    work(root, outer);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
}
it('archives and materializes only exact endpoints and pinned ancestors', () =>
  fixture((root, outer) => {
    fs.mkdirSync(join(root, 'nested'));
    fs.writeFileSync(join(root, 'nested', 'raw'), Buffer.from([0, 255, 22]), { mode: 0o751 });
    fs.linkSync(join(root, 'nested', 'raw'), join(root, 'alias'));
    fs.symlinkSync('nested/raw', join(root, 'link'));
    fs.writeFileSync(join(root, 'private.key'), 'synthetic');
    fs.writeFileSync(join(root, 'nested', 'unrelated'), 'omit');
    const paths = ['nested/raw', 'link', 'alias'];
    vi.mocked(fs.openSync).mockClear();
    const captured = assets.captureCodingAssetFiles(root, paths, { bytes: 3, entries: 5 });
    paths.splice(0, 3, 'private.key');
    expect(captured.manifest.selectedFiles).toEqual(['alias', 'link', 'nested/raw']);
    assets.archiveCodingAssetTree(captured, join(outer, 'archive'));
    expect(assets.verifyCodingAssetArchive(join(outer, 'archive'))).toEqual(captured.manifest);
    assets.restoreCodingAssetTree(join(outer, 'archive'), join(outer, 'restore'));
    const tree = join(outer, 'restore', 'tree');
    expect(fs.readdirSync(tree).sort()).toEqual(['alias', 'link', 'nested']);
    expect(fs.readdirSync(join(tree, 'nested'))).toEqual(['raw']);
    expect(fs.readFileSync(join(tree, 'alias'))).toEqual(Buffer.from([0, 255, 22]));
    expect(fs.statSync(join(tree, 'alias')).ino).toBe(fs.statSync(join(tree, 'nested', 'raw')).ino);
    expect(fs.readlinkSync(join(tree, 'link'))).toBe('nested/raw');
    expect(
      vi
        .mocked(fs.openSync)
        .mock.calls.some(
          ([path]) => String(path).endsWith('private.key') || String(path).endsWith('unrelated'),
        ),
    ).toBe(false);
  }));
it('refuses non-endpoints, unselected hardlink aliases, protected and noncanonical selections before body reads', () =>
  fixture((root) => {
    fs.mkdirSync(join(root, 'dir'));
    fs.writeFileSync(join(root, 'dir', 'file'), 'safe');
    fs.writeFileSync(join(root, 'b.key'), 'synthetic');
    fs.linkSync(join(root, 'b.key'), join(root, 'a'));
    fs.symlinkSync('dir', join(root, 'symlink'));
    for (const paths of [
      ['dir'],
      ['dir', 'dir/file'],
      ['symlink/file'],
      ['../dir/file'],
      ['./dir/file'],
      ['dir//file'],
      ['dir/file', 'dir/file'],
      ['dir/file', 'b.key'],
      ['a'],
    ]) {
      vi.mocked(fs.readSync).mockClear();
      expect(() => assets.captureCodingAssetFiles(root, paths)).toThrow();
      expect(fs.readSync).not.toHaveBeenCalled();
    }
  }));
it('verifies selected membership independently of a recomputed portable digest', () =>
  fixture((root, outer) => {
    fs.mkdirSync(join(root, 'dir'));
    fs.writeFileSync(join(root, 'dir', 'one'), 'data');
    const capture = assets.captureCodingAssetFiles(root, ['dir/one']),
      archive = join(outer, 'archive');
    assets.archiveCodingAssetTree(capture, archive);
    for (const selectedFiles of [
      ['dir/missing'],
      ['dir/one', 'dir/missing'],
      ['dir/one', '../escape'],
      ['dir'],
    ]) {
      const { hash: _, ...body } = capture.manifest;
      const changed = { ...body, selectedFiles };
      fs.writeFileSync(
        join(archive, 'manifest.json'),
        JSON.stringify({
          ...changed,
          hash: createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
        }),
      );
      expect(() => assets.verifyCodingAssetArchive(archive)).toThrow(
        'invalid_coding_asset_archive',
      );
    }
  }));
it('retains the lowered selected byte limit during archive preflight before reading a grown file', () =>
  fixture((root, outer) => {
    fs.writeFileSync(join(root, 'one'), 'x');
    const capture = assets.captureCodingAssetFiles(root, ['one'], { bytes: 1 });
    fs.writeFileSync(join(root, 'one'), 'xx');
    vi.mocked(fs.readSync).mockClear();
    expect(() => assets.archiveCodingAssetTree(capture, join(outer, 'archive'))).toThrow(
      'coding_asset_limit',
    );
    expect(fs.readSync).not.toHaveBeenCalled();
  }));

it.each(['modified', 'fabricated'] as const)(
  'rejects a %s capture before a downgraded archive can open any source',
  (kind) =>
    fixture((root, outer) => {
      fs.writeFileSync(join(root, 'x'), 'x');
      fs.writeFileSync(join(root, 'private.key'), 'synthetic');
      const issued = assets.captureCodingAssetFiles(root, ['x'], { bytes: 1 });
      const capture = kind === 'modified' ? issued : structuredClone(issued);
      if (kind === 'modified') {
        const { hash: _hash, selectedFiles: _selection, ...body } = capture.manifest;
        Object.assign(capture, {
          policy: 'all',
          limits: { ...capture.limits, bytes: 100 },
          manifest: {
            ...body,
            hash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
          },
        });
      }
      vi.mocked(fs.openSync).mockClear();
      let error: unknown;
      try {
        assets.archiveCodingAssetTree(capture, join(outer, 'archive'));
      } catch (thrown) {
        error = thrown;
      }
      const opens = vi.mocked(fs.openSync).mock.calls.map(([path]) => String(path));
      expect(opens.filter((name) => name.endsWith('/private.key'))).toEqual([]);
      expect(opens).toEqual([]);
      expect(error).toEqual(Error('invalid_coding_asset_capture'));
    }),
);
