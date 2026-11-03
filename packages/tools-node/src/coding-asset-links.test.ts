import { createHash } from 'node:crypto';
import type { CodingAssetEntry, CodingAssetManifest } from '@runnets/domain';
import { expect, it } from 'vitest';
import { validateCodingAssetLinks } from './coding-asset-links.js';
function manifest(entries: CodingAssetEntry[]): CodingAssetManifest {
  const body = {
    format: 1 as const,
    entries: [{ path: '', kind: 'directory' as const, mode: 0o700 }, ...entries],
    bytes: 0,
  };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
const directory = (path: string): CodingAssetEntry => ({ path, kind: 'directory', mode: 0o755 });
const link = (path: string, target: string): CodingAssetEntry => ({
  path,
  kind: 'symlink',
  target,
});
it('resolves internal link chains and dotdot after intermediate symlinks using only manifest data', () => {
  const data = manifest([
    directory('a'),
    directory('b'),
    directory('b/deep'),
    link('a/x', '../b/deep'),
    link('chain', 'a/x/..'),
    link('root', '.'),
    link('literal\\name', 'b'),
  ]);
  expect(validateCodingAssetLinks(data)).toEqual([
    { path: 'a/x', target: 'b/deep' },
    { path: 'chain', target: 'b' },
    { path: 'root', target: '' },
    { path: 'literal\\name', target: 'b' },
  ]);
});
it.each([
  [link('escape', '../secret')],
  [link('absolute', '/home/user/key')],
  [link('missing', 'absent')],
  [link('cycle', 'cycle')],
  [link('a', 'b'), link('b', 'a')],
  [link('prefix', 'absent/../')],
  [directory('a'), link('a/up', '../..')],
])('refuses unresolved or external links before materialization: %j', (...entries) => {
  expect(() => validateCodingAssetLinks(manifest(entries))).toThrow(
    'coding_asset_links_unavailable',
  );
});
it('rejects traversal through a regular file and bounds repeated expansions', () => {
  const empty: CodingAssetEntry = {
    path: 'file',
    kind: 'file',
    mode: 0o600,
    bytes: 0,
    sha256: createHash('sha256').update('').digest('hex'),
  };
  expect(() => validateCodingAssetLinks(manifest([empty, link('bad', 'file/..')]))).toThrow();
  const entries: CodingAssetEntry[] = [directory('dir')];
  for (let index = 0; index < 42; index++)
    entries.push(link('l' + index, index === 41 ? 'dir' : 'l' + (index + 1)));
  expect(() => validateCodingAssetLinks(manifest(entries))).toThrow(
    'coding_asset_links_unavailable',
  );
});
it('bounds aggregate link traversal work independently of entry and per-link hop limits', () => {
  const entries: CodingAssetEntry[] = [directory('dir')];
  for (let index = 0; index < 20000; index++)
    entries.push(link('l' + index, './'.repeat(50) + 'dir'));
  expect(() => validateCodingAssetLinks(manifest(entries))).toThrow(
    'coding_asset_links_unavailable',
  );
});
