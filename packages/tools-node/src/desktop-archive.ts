import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { archiveCodingAssetTree } from './coding-asset-archive.js';
import { restoreCodingAssetTree } from './coding-asset-restore.js';
import {
  privateAssetChild,
  privateAssetDirectory,
  assetDirectoryFlags,
  assetFdPath,
  assetNames,
  checkAssetPath,
} from './coding-asset-io.js';
import {
  checkedDesktopCapture,
  checkDesktopCapture,
  type DesktopAssetCapture,
  type DesktopAssetCatalog,
} from './desktop-assets.js';
import { verifyDesktopArchive } from './desktop-archive-verify.js';
function write(root: number, name: string, data: string) {
  const fd = fs.openSync(join(assetFdPath(root), name), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function create(path: string): number {
  if (resolve(path) !== path || fs.realpathSync(dirname(path)) !== dirname(path))
    throw Error('invalid_desktop_archive');
  const parent = fs.openSync(dirname(path), assetDirectoryFlags);
  try {
    checkAssetPath(parent, dirname(path));
    fs.mkdirSync(join(assetFdPath(parent), basename(path)), { mode: 0o700 });
    const root = privateAssetChild(parent, basename(path), path);
    try {
      if (assetNames(root, 1).length) throw Error('invalid_desktop_archive');
      write(root, '.incomplete', '');
      fs.fsyncSync(root);
      fs.fsyncSync(parent);
      return root;
    } catch (e) {
      fs.closeSync(root);
      throw e;
    }
  } finally {
    fs.closeSync(parent);
  }
}
export function archiveDesktopAssets(
  capture: DesktopAssetCapture,
  destination: string,
): DesktopAssetCatalog {
  const source = checkedDesktopCapture(capture);
  if (destination === source.root || destination.startsWith(source.root + '/'))
    throw Error('invalid_desktop_archive');
  const root = create(destination);
  try {
    archiveCodingAssetTree(source, join(destination, 'assets'));
    checkAssetPath(root, destination);
    write(root, 'catalog.json', JSON.stringify(capture.catalog));
    fs.fsyncSync(root);
    verifyDesktopArchive(destination, true, () => checkDesktopCapture(capture));
    fs.unlinkSync(join(assetFdPath(root), '.incomplete'));
    fs.fsyncSync(root);
    checkAssetPath(root, destination);
    return verifyDesktopArchive(destination, false, () => checkDesktopCapture(capture));
  } finally {
    fs.closeSync(root);
  }
}
export function verifyDesktopAssetArchive(directory: string): DesktopAssetCatalog {
  return verifyDesktopArchive(directory);
}
export function restoreDesktopAssets(archive: string, destination: string): DesktopAssetCatalog {
  return verifyDesktopArchive(archive, false, (catalog) => {
    restoreCodingAssetTree(join(archive, 'assets'), destination);
    const root = privateAssetDirectory(destination);
    try {
      write(root, 'desktop-evidence.json', JSON.stringify(catalog.inventory));
      fs.fsyncSync(root);
      checkAssetPath(root, destination);
    } finally {
      fs.closeSync(root);
    }
  });
}
