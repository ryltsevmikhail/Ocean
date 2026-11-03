import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateCodingAssetManifest } from './coding-asset-validation.js';
const root = { path: '', kind: 'directory', mode: 0o700 };
const sha256 = createHash('sha256').update('a').digest('hex');
const seal = (entries: unknown[], bytes = 0) => {
  const body = { format: 1, entries, bytes };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
};
it.each([
  [root, { path: '../escape', kind: 'file', mode: 0o600, bytes: 0, sha256 }],
  [root, { path: '/absolute', kind: 'directory', mode: 0o700 }],
  [root, { path: 'a/file', kind: 'directory', mode: 0o700 }],
  [root, { path: 'a', kind: 'directory', mode: 0o4755 }],
  [root, root],
  [
    root,
    { path: 's', kind: 'symlink', target: 'elsewhere' },
    { path: 'h', kind: 'hardlink', target: 's' },
  ],
])('refuses unsafe or inconsistent metadata even with a recomputed hash: %j', (...entries) => {
  expect(() => validateCodingAssetManifest(seal(entries))).toThrow('invalid_coding_asset_archive');
});
it('keeps escaping symlinks as inert data and enforces depth and shared-blob size consistency', () => {
  const links = seal([root, { path: 'link', kind: 'symlink', target: '../../outside' }]);
  expect(validateCodingAssetManifest(links)).toEqual(links);
  expect(() =>
    validateCodingAssetManifest(
      seal(
        [
          root,
          { path: 'a', kind: 'file', mode: 0o600, bytes: 1, sha256 },
          { path: 'b', kind: 'file', mode: 0o600, bytes: 2, sha256 },
        ],
        3,
      ),
    ),
  ).toThrow();
  const deep = [root];
  for (let depth = 1; depth <= 129; depth++)
    deep.push({
      path: Array.from({ length: depth }, () => 'a').join('/'),
      kind: 'directory',
      mode: 0o700,
    });
  expect(() => validateCodingAssetManifest(seal(deep))).toThrow();
});
