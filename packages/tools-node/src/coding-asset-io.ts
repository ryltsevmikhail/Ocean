import { checkProfileArchiveFile } from './profile-archive-context.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CodingAssetManifest } from '@runnets/domain';
import { codingAssetIdentity } from './coding-asset-scan.js';
export const assetDirectoryFlags =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
export const assetFdPath = (fd: number) => '/proc/self/fd/' + String(fd);
export function privateAssetDirectory(path: string): number {
  if (process.platform !== 'linux' || fs.realpathSync(path) !== path)
    throw Error('invalid_coding_asset_archive');
  const fd = fs.openSync(path, assetDirectoryFlags);
  try {
    const s = fs.fstatSync(fd);
    if (s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0)
      throw Error('invalid_coding_asset_archive');
    checkAssetPath(fd, path);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export function privateAssetChild(parent: number, name: string, expectedPath: string): number {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
    throw Error('invalid_coding_asset_archive');
  const fd = fs.openSync(join(assetFdPath(parent), name), assetDirectoryFlags);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw Error('invalid_coding_asset_archive');
    checkAssetPath(fd, expectedPath);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export function assetNames(fd: number, limit: number, admit?: (name: string) => void): string[] {
  const listing = fs.opendirSync(assetFdPath(fd), { bufferSize: 32 });
  const names: string[] = [];
  try {
    for (let entry = listing.readSync(); entry !== null; entry = listing.readSync()) {
      if (names.length >= limit) throw Error('invalid_coding_asset_archive');
      admit?.(entry.name);
      names.push(entry.name);
    }
  } finally {
    listing.closeSync();
  }
  return names.sort();
}
export function checkAssetPath(fd: number, path: string): void {
  if (fs.realpathSync(assetFdPath(fd)) !== path) throw Error('stale_coding_asset');
}
export function readAssetBlob(
  directory: number,
  name: string,
  expectedBytes: number,
  consume?: (buffer: Buffer) => void,
): string {
  const file = fs.openSync(
    join(assetFdPath(directory), name),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    checkProfileArchiveFile(file);
    const before = fs.fstatSync(file, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o077n) !== 0n ||
      before.size !== BigInt(expectedBytes)
    )
      throw Error('invalid_coding_asset_archive');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(Math.min(1048576, expectedBytes || 1));
    let position = 0;
    while (position < expectedBytes) {
      const count = fs.readSync(
        file,
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - position),
        position,
      );
      if (!count) throw Error('invalid_coding_asset_archive');
      const chunk = buffer.subarray(0, count);
      hash.update(chunk);
      consume?.(chunk);
      position += count;
    }
    if (
      codingAssetIdentity(before) !== codingAssetIdentity(fs.fstatSync(file, { bigint: true })) ||
      codingAssetIdentity(before) !==
        codingAssetIdentity(fs.lstatSync(join(assetFdPath(directory), name), { bigint: true }))
    )
      throw Error('stale_coding_asset');
    return hash.digest('hex');
  } finally {
    fs.closeSync(file);
  }
}
export function verifyAssetBlobs(directory: number, manifest: CodingAssetManifest): void {
  const expected = new Map(
    manifest.entries.flatMap((entry) =>
      entry.kind === 'file' ? [[entry.sha256, entry.bytes] as const] : [],
    ),
  );
  const before = fs.fstatSync(directory, { bigint: true });
  const names = assetNames(directory, expected.size + 1);
  if (names.length !== expected.size || names.some((name) => !expected.has(name)))
    throw Error('invalid_coding_asset_archive');
  for (const [name, bytes] of expected)
    if (readAssetBlob(directory, name, bytes) !== name) throw Error('invalid_coding_asset_archive');
  if (
    codingAssetIdentity(before) !== codingAssetIdentity(fs.fstatSync(directory, { bigint: true }))
  )
    throw Error('stale_coding_asset');
}
