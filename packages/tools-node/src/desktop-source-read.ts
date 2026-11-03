import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  codingAssetIdentity,
  codingAssetMount,
  type CodingAssetCapture,
} from './coding-asset-scan.js';
import { assetDirectoryFlags, assetFdPath, checkAssetPath } from './coding-asset-io.js';
/** Open only an exact metadata-preflight witness; never follow a substituted source name. */
export function readDesktopSource(source: CodingAssetCapture, path: string): Buffer {
  const states = new Map(source.sourceEntries),
    parts = path.split('/');
  const entry = source.manifest.entries.find((e) => e.path === path);
  if (!entry || entry.kind !== 'file' || entry.bytes > 131072)
    throw Error('desktop_asset_corrupted');
  let parent = fs.openSync(source.root, assetDirectoryFlags),
    relative = '';
  const check = (fd: number, name: string) => {
    if (
      codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== states.get(name) ||
      codingAssetMount(fd) !== source.sourceMount
    )
      throw Error('stale_coding_asset');
    checkAssetPath(fd, name ? join(source.root, name) : source.root);
  };
  try {
    check(parent, '');
    for (const part of parts.slice(0, -1)) {
      relative = relative ? relative + '/' + part : part;
      const next = fs.openSync(join(assetFdPath(parent), part), assetDirectoryFlags);
      fs.closeSync(parent);
      parent = next;
      check(parent, relative);
    }
    const file = fs.openSync(
      join(assetFdPath(parent), parts.at(-1)!),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      check(file, path);
      const result = Buffer.alloc(entry.bytes);
      let offset = 0;
      while (offset < result.length) {
        const n = fs.readSync(file, result, offset, result.length - offset, offset);
        if (!n) throw Error('stale_coding_asset');
        offset += n;
      }
      check(file, path);
      if (
        codingAssetIdentity(
          fs.lstatSync(join(assetFdPath(parent), parts.at(-1)!), { bigint: true }),
        ) !== states.get(path)
      )
        throw Error('stale_coding_asset');
      return result;
    } finally {
      fs.closeSync(file);
    }
  } finally {
    fs.closeSync(parent);
  }
}
