import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  linkSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureCodingAssetTree } from './coding-asset-scan.js';
import { archiveCodingAssetTree, verifyCodingAssetArchive } from './coding-asset-archive.js';
it.runIf(process.platform === 'linux')(
  'archives exact verified blobs and inert relationships without materializing links',
  () => {
    const outer = mkdtempSync(join(tmpdir(), 'ocean-asset-archive-')),
      root = join(outer, 'source'),
      target = join(outer, 'archive');
    mkdirSync(root, { mode: 0o700 });
    try {
      writeFileSync(join(root, 'a'), Buffer.from([0, 255, 0, 13, 10]), { mode: 0o600 });
      linkSync(join(root, 'a'), join(root, 'b'));
      writeFileSync(join(root, 'same-bytes'), Buffer.from([0, 255, 0, 13, 10]), { mode: 0o600 });
      symlinkSync('../../private-key', join(root, 'link'));
      const captured = captureCodingAssetTree(root);
      expect(archiveCodingAssetTree(captured, target)).toEqual(captured.manifest);
      expect(verifyCodingAssetArchive(target)).toEqual(captured.manifest);
      expect(readdirSync(join(target, 'blobs'))).toHaveLength(1);
      expect(existsSync(join(target, 'link'))).toBe(false);
      expect(existsSync(join(target, '.incomplete'))).toBe(false);
      const blob = readdirSync(join(target, 'blobs'))[0]!;
      expect(readFileSync(join(target, 'blobs', blob))).toEqual(Buffer.from([0, 255, 0, 13, 10]));
      expect(() => archiveCodingAssetTree(captured, target)).toThrow();
      writeFileSync(join(target, 'blobs', blob), 'corrupt');
      expect(() => verifyCodingAssetArchive(target)).toThrow();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses stale source and destinations inside it without changing source data',
  () => {
    const outer = mkdtempSync(join(tmpdir(), 'ocean-asset-stale-')),
      root = join(outer, 'source');
    mkdirSync(root, { mode: 0o700 });
    try {
      writeFileSync(join(root, 'file'), 'before');
      const captured = captureCodingAssetTree(root);
      expect(() => archiveCodingAssetTree(captured, join(root, 'backup'))).toThrow();
      expect(existsSync(join(root, 'backup'))).toBe(false);
      writeFileSync(join(root, 'file'), 'user');
      expect(() => archiveCodingAssetTree(captured, join(outer, 'backup'))).toThrow(
        'stale_coding_asset',
      );
      expect(readFileSync(join(root, 'file'), 'utf8')).toBe('user');
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux')(
  'refuses incomplete, escaped or multiply-linked archive data without exposing malformed content',
  () => {
    const outer = mkdtempSync(join(tmpdir(), 'ocean-archive-verify-')),
      root = join(outer, 'source'),
      target = join(outer, 'archive');
    mkdirSync(root, { mode: 0o700 });
    try {
      writeFileSync(join(root, 'file'), 'bytes');
      archiveCodingAssetTree(captureCodingAssetTree(root), target);
      writeFileSync(join(target, '.incomplete'), 'interrupted', { mode: 0o600 });
      expect(() => verifyCodingAssetArchive(target)).toThrow();
      rmSync(join(target, '.incomplete'));
      const name = readdirSync(join(target, 'blobs'))[0]!,
        blob = join(target, 'blobs', name);
      linkSync(blob, join(outer, 'alias'));
      expect(() => verifyCodingAssetArchive(target)).toThrow();
      rmSync(join(outer, 'alias'));
      rmSync(blob);
      symlinkSync(join(root, 'file'), blob);
      expect(() => verifyCodingAssetArchive(target)).toThrow();
      writeFileSync(join(target, 'manifest.json'), 'secret-must-not-appear-in-error');
      expect(() => verifyCodingAssetArchive(target)).toThrow('invalid_coding_asset_archive');
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  },
);
