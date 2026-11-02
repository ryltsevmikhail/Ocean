import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CodingAssetManifest } from '@runnets/domain';
import { verifyCodingAssetArchive } from './coding-asset-archive.js';
import { validateCodingAssetLinks } from './coding-asset-links.js';
import { captureCodingAssetTree } from './coding-asset-scan.js';
import {
  assetDirectoryFlags,
  assetFdPath,
  assetNames,
  checkAssetPath,
  privateAssetChild,
  privateAssetDirectory,
  readAssetBlob,
} from './coding-asset-io.js';
const identity = (fd: number): string => {
  const stat = fs.fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};
function write(fd: number, chunk: Buffer): void {
  let offset = 0;
  while (offset < chunk.length) {
    const count = fs.writeSync(fd, chunk, offset, chunk.length - offset);
    if (!count) throw Error('coding_asset_write_failed');
    offset += count;
  }
}
/** New quarantine only; no database rebinding, operation replay or project activation. */
export function restoreCodingAssetTree(archive: string, destination: string): CodingAssetManifest {
  const manifest = verifyCodingAssetArchive(archive);
  validateCodingAssetLinks(manifest);
  if (
    resolve(destination) !== destination ||
    fs.existsSync(destination) ||
    fs.realpathSync(dirname(destination)) !== dirname(destination) ||
    destination.startsWith(archive + '/')
  )
    throw Error('invalid_coding_asset_destination');
  const parent = fs.openSync(dirname(destination), assetDirectoryFlags);
  let output: number | undefined,
    root: number | undefined,
    input: number | undefined,
    blobs: number | undefined;
  const directories = new Map<string, string>();
  const directory = (path: string): number => {
    if (root === undefined) throw Error('invalid_coding_asset_destination');
    // Open an independent handle even for the root; callers always close it.
    let fd = fs.openSync(assetFdPath(root), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      let relative = '';
      if (identity(fd) !== directories.get('')) throw Error('stale_coding_asset');
      for (const part of path ? path.split('/') : []) {
        const next = fs.openSync(join(assetFdPath(fd), part), assetDirectoryFlags);
        fs.closeSync(fd);
        fd = next;
        relative = relative ? relative + '/' + part : part;
        if (identity(fd) !== directories.get(relative)) throw Error('stale_coding_asset');
      }
      checkAssetPath(fd, join(destination, 'tree', path));
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };
  try {
    checkAssetPath(parent, dirname(destination));
    fs.mkdirSync(join(assetFdPath(parent), basename(destination)), { mode: 0o700 });
    output = privateAssetChild(parent, basename(destination), destination);
    if (assetNames(output, 1).length) throw Error('stale_coding_asset');
    const intent = fs.openSync(join(assetFdPath(output), '.incomplete'), 'wx', 0o600);
    try {
      write(intent, Buffer.from(JSON.stringify({ format: 1, manifestHash: manifest.hash })));
      fs.fsyncSync(intent);
    } finally {
      fs.closeSync(intent);
    }
    fs.fsyncSync(output);
    fs.mkdirSync(join(assetFdPath(output), 'tree'), { mode: 0o700 });
    root = privateAssetChild(output, 'tree', join(destination, 'tree'));
    directories.set('', identity(root));
    input = privateAssetDirectory(archive);
    blobs = privateAssetChild(input, 'blobs', join(archive, 'blobs'));
    for (const entry of manifest.entries.slice(1)) {
      if (entry.kind === 'symlink' || entry.kind === 'hardlink') continue;
      const fd = directory(dirname(entry.path) === '.' ? '' : dirname(entry.path));
      try {
        const path = join(assetFdPath(fd), basename(entry.path));
        if (entry.kind === 'directory') {
          fs.mkdirSync(path, { mode: 0o700 });
          const child = fs.openSync(path, assetDirectoryFlags);
          try {
            directories.set(entry.path, identity(child));
            fs.fsyncSync(child);
          } finally {
            fs.closeSync(child);
          }
        } else {
          const file = fs.openSync(path, 'wx', 0o600);
          try {
            if (
              readAssetBlob(blobs, entry.sha256, entry.bytes, (chunk) => write(file, chunk)) !==
              entry.sha256
            )
              throw Error('invalid_coding_asset_archive');
            fs.fchmodSync(file, entry.mode);
            fs.fsyncSync(file);
          } finally {
            fs.closeSync(file);
          }
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    // Parents are real, newly created directories; links cannot become traversal parents.
    for (const entry of manifest.entries) {
      if (entry.kind !== 'hardlink' && entry.kind !== 'symlink') continue;
      const fd = directory(dirname(entry.path) === '.' ? '' : dirname(entry.path));
      try {
        const path = join(assetFdPath(fd), basename(entry.path));
        if (entry.kind === 'symlink') fs.symlinkSync(entry.target, path);
        else {
          const target = directory(dirname(entry.target) === '.' ? '' : dirname(entry.target));
          try {
            fs.linkSync(join(assetFdPath(target), basename(entry.target)), path);
          } finally {
            fs.closeSync(target);
          }
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    for (const entry of [...manifest.entries].reverse()) {
      if (entry.kind !== 'directory') continue;
      const fd = directory(entry.path);
      try {
        fs.fchmodSync(fd, entry.mode);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    checkAssetPath(output, destination);
    if (
      JSON.stringify(captureCodingAssetTree(join(destination, 'tree')).manifest.entries) !==
        JSON.stringify(manifest.entries) ||
      verifyCodingAssetArchive(archive).hash !== manifest.hash
    )
      throw Error('stale_coding_asset');
    fs.unlinkSync(join(assetFdPath(output), '.incomplete'));
    fs.fsyncSync(output);
    checkAssetPath(parent, dirname(destination));
    fs.fsyncSync(parent);
    return manifest;
  } finally {
    if (blobs !== undefined) fs.closeSync(blobs);
    if (input !== undefined) fs.closeSync(input);
    if (root !== undefined) fs.closeSync(root);
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(parent);
  }
}
