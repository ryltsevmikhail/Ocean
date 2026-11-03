import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  linkSync,
  symlinkSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { captureCodingAssetTree } from './coding-asset-scan.js';
it.runIf(process.platform === 'linux')(
  'captures exact bytes, modes, empty directories and internal hardlinks without following symlinks',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'ocean-asset-scan-'));
    try {
      mkdirSync(join(root, 'empty'));
      writeFileSync(join(root, 'file'), '\ufeffbytes\r\n');
      chmodSync(join(root, 'file'), 0o755);
      linkSync(join(root, 'file'), join(root, 'hard'));
      symlinkSync('../outside-private', join(root, 'outside-link'));
      const value = captureCodingAssetTree(root);
      expect(value.manifest.entries).toEqual([
        { path: '', kind: 'directory', mode: 0o700 },
        { path: 'empty', kind: 'directory', mode: 0o755 },
        {
          path: 'file',
          kind: 'file',
          mode: 0o755,
          bytes: Buffer.byteLength('\ufeffbytes\r\n'),
          sha256: createHash('sha256').update('\ufeffbytes\r\n').digest('hex'),
        },
        { path: 'hard', kind: 'hardlink', target: 'file' },
        { path: 'outside-link', kind: 'symlink', target: '../outside-private' },
      ]);
      expect(captureCodingAssetTree(root)).toEqual(value);
      writeFileSync(join(root, 'file'), 'changed');
      expect(captureCodingAssetTree(root).manifest.hash).not.toBe(value.manifest.hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses limits, root links, special modes and invalid UTF-8 names without partial manifests',
  () => {
    const outer = mkdtempSync(join(tmpdir(), 'ocean-asset-refuse-')),
      root = join(outer, 'root');
    mkdirSync(root);
    try {
      writeFileSync(join(root, 'file'), '12345');
      expect(() => captureCodingAssetTree(root, { bytes: 4 })).toThrow('coding_asset_limit');
      expect(() => captureCodingAssetTree(root, { entries: 1 })).toThrow('coding_asset_limit');
      mkdirSync(join(root, 'a/b'), { recursive: true });
      expect(() => captureCodingAssetTree(root, { depth: 1 })).toThrow('coding_asset_limit');
      symlinkSync(root, join(outer, 'alias'));
      expect(() => captureCodingAssetTree(join(outer, 'alias'))).toThrow();
      chmodSync(join(root, 'file'), 0o4755);
      expect(() => captureCodingAssetTree(root)).toThrow('unsupported_coding_asset');
      chmodSync(join(root, 'file'), 0o600);
      writeFileSync(Buffer.concat([Buffer.from(root + '/'), Buffer.from([0xff])]), 'bad');
      expect(() => captureCodingAssetTree(root)).toThrow('unsupported_coding_asset');
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux')(
  'keeps binary content portable across roots while retaining distinct source identity evidence',
  () => {
    const outer = mkdtempSync(join(tmpdir(), 'ocean-asset-portable-'));
    const left = join(outer, 'left'),
      right = join(outer, 'right');
    const bytes = Buffer.from([0, 255, 128, 13, 10, 0]);
    try {
      for (const root of [left, right]) {
        mkdirSync(root, { mode: 0o700 });
        writeFileSync(join(root, 'binary'), bytes, { mode: 0o600 });
      }
      const first = captureCodingAssetTree(left),
        second = captureCodingAssetTree(right);
      expect(first.manifest).toEqual(second.manifest);
      expect(first.sourceStateHash).not.toBe(second.sourceStateHash);
      expect(first.manifest.entries[1]).toMatchObject({
        kind: 'file',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  },
);
