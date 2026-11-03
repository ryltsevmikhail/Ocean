import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { captureCodingAssetTree } from './coding-asset-scan.js';
it.runIf(process.platform === 'linux')(
  'bounds all pending ancestor directory listings before allocating another subtree',
  () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'ocean-asset-pending-'));
    let parent = root;
    for (let depth = 0; depth < 5; depth++) {
      for (const name of ['x', 'y', 'z']) fs.writeFileSync(join(parent, name), '');
      parent = join(parent, 'a');
      fs.mkdirSync(parent);
    }
    const original = Object.getOwnPropertyDescriptor(fs.Dir.prototype, 'readSync')!
      .value as fs.Dir['readSync'];
    let listed = 0;
    const spy = vi.spyOn(fs.Dir.prototype, 'readSync').mockImplementation(function (this: fs.Dir) {
      const value = original.call(this);
      if (value !== null) listed++;
      return value;
    });
    try {
      expect(() => captureCodingAssetTree(root, { entries: 8 })).toThrow('coding_asset_limit');
      expect(listed).toBeLessThanOrEqual(8);
    } finally {
      spy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
