import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureCodingAssetTree } from './coding-asset-scan.js';
import { archiveCodingAssetTree } from './coding-asset-archive.js';
import { restoreCodingAssetTree } from './coding-asset-restore.js';
it.runIf(process.platform === 'linux')(
  'restores verified bytes, modes and internal links inside a new private quarantine',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-asset-restore-')),
      source = join(outer, 'source'),
      archive = join(outer, 'archive'),
      output = join(outer, 'quarantine');
    fs.mkdirSync(source, { mode: 0o755 });
    fs.mkdirSync(join(source, 'dir'), { mode: 0o750 });
    fs.mkdirSync(join(source, 'empty'));
    fs.writeFileSync(join(source, 'dir', 'a'), Buffer.from([0, 255, 13, 10]), { mode: 0o640 });
    fs.linkSync(join(source, 'dir', 'a'), join(source, 'hardlink'));
    fs.symlinkSync('dir/a', join(source, 'link'));
    fs.symlinkSync('dir', join(source, 'dirlink'));
    try {
      const capture = captureCodingAssetTree(source);
      archiveCodingAssetTree(capture, archive);
      expect(restoreCodingAssetTree(archive, output)).toEqual(capture.manifest);
      expect(captureCodingAssetTree(join(output, 'tree')).manifest).toEqual(capture.manifest);
      expect(fs.statSync(output).mode & 0o777).toBe(0o700);
      expect(fs.statSync(join(output, 'tree/hardlink')).ino).toBe(
        fs.statSync(join(output, 'tree/dir/a')).ino,
      );
      expect(fs.statSync(join(output, 'tree/dir/a')).ino).not.toBe(
        fs.statSync(join(source, 'dir/a')).ino,
      );
      expect(fs.existsSync(join(output, '.incomplete'))).toBe(false);
      expect(() => restoreCodingAssetTree(archive, output)).toThrow();
      expect(fs.readFileSync(join(source, 'dir/a'))).toEqual(Buffer.from([0, 255, 13, 10]));
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses external or dangling links and corrupt blobs before creating output',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-restore-refusal-')),
      source = join(outer, 'source'),
      archive = join(outer, 'archive'),
      output = join(outer, 'out');
    fs.mkdirSync(source);
    fs.symlinkSync('../private-key', join(source, 'link'));
    try {
      archiveCodingAssetTree(captureCodingAssetTree(source), archive);
      expect(() => restoreCodingAssetTree(archive, output)).toThrow(
        'coding_asset_links_unavailable',
      );
      expect(fs.existsSync(output)).toBe(false);
      fs.rmSync(archive, { recursive: true });
      fs.rmSync(join(source, 'link'));
      fs.writeFileSync(join(source, 'file'), 'before');
      archiveCodingAssetTree(captureCodingAssetTree(source), archive);
      fs.writeFileSync(
        join(archive, 'blobs', fs.readdirSync(join(archive, 'blobs'))[0]!),
        'corrupt',
      );
      expect(() => restoreCodingAssetTree(archive, output)).toThrow();
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
