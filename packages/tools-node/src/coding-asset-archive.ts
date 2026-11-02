import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { CodingAssetManifest } from '@runnets/domain';
import {
  captureAssetTreeAt,
  checkedArchiveInput,
  codingAssetIdentity,
  codingAssetMount,
  type CodingAssetCapture,
} from './coding-asset-scan.js';
import { validateCodingAssetManifest } from './coding-asset-validation.js';
import {
  assetDirectoryFlags,
  assetFdPath,
  privateAssetDirectory,
  privateAssetChild,
  assetNames,
  checkAssetPath,
  verifyAssetBlobs,
} from './coding-asset-io.js';
function write(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (!count) throw Error('coding_asset_write_failed');
    offset += count;
  }
}
function sourceFile(
  root: number,
  capture: CodingAssetCapture,
  path: string,
  states: ReadonlyMap<string, string>,
): number {
  const parts = path.split('/'),
    mount = codingAssetMount(root);
  let parent = root,
    relative = '';
  try {
    for (const part of parts.slice(0, -1)) {
      relative = relative ? relative + '/' + part : part;
      const next = fs.openSync(join(assetFdPath(parent), part), assetDirectoryFlags);
      if (parent !== root) fs.closeSync(parent);
      parent = next;
      if (
        codingAssetMount(parent) !== mount ||
        codingAssetIdentity(fs.fstatSync(parent, { bigint: true })) !== states.get(relative)
      )
        throw Error('stale_coding_asset');
      checkAssetPath(parent, join(capture.root, relative));
    }
    const file = fs.openSync(
      join(assetFdPath(parent), parts.at(-1)!),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      if (
        codingAssetMount(file) !== mount ||
        codingAssetIdentity(fs.fstatSync(file, { bigint: true })) !== states.get(path)
      )
        throw Error('stale_coding_asset');
      checkAssetPath(file, join(capture.root, path));
      return file;
    } catch (error) {
      fs.closeSync(file);
      throw error;
    }
  } finally {
    if (parent !== root) fs.closeSync(parent);
  }
}
function recapture(
  expected: CodingAssetCapture,
  manifest: CodingAssetManifest,
): CodingAssetCapture {
  return captureAssetTreeAt(
    expected.root,
    expected.limits,
    expected.policy,
    undefined,
    (metadata) => {
      if (metadata.sourceStateHash !== expected.sourceStateHash) throw Error('stale_coding_asset');
    },
    manifest.selectedFiles,
  );
}
/** New private output only. On failure its incomplete data is retained, never recursively cleaned. */
export function archiveCodingAssetTree(
  handle: CodingAssetCapture,
  destination: string,
): CodingAssetManifest {
  const expected = checkedArchiveInput(handle);
  if (
    resolve(destination) !== destination ||
    destination === expected.root ||
    destination.startsWith(expected.root + '/') ||
    fs.existsSync(destination) ||
    fs.realpathSync(dirname(destination)) !== dirname(destination)
  )
    throw Error('invalid_coding_asset_destination');
  const manifest = validateCodingAssetManifest(expected.manifest),
    fresh = recapture(expected, manifest);
  if (fresh.manifest.hash !== manifest.hash || fresh.sourceStateHash !== expected.sourceStateHash)
    throw Error('stale_coding_asset');
  const parent = fs.openSync(dirname(destination), assetDirectoryFlags);
  let output: number | undefined;
  let blobs: number | undefined, source: number | undefined;
  try {
    checkAssetPath(parent, dirname(destination));
    fs.mkdirSync(join(assetFdPath(parent), basename(destination)), { mode: 0o700 });
    const created = fs.lstatSync(join(assetFdPath(parent), basename(destination)), {
      bigint: true,
    });
    output = privateAssetChild(parent, basename(destination), destination);
    if (
      codingAssetIdentity(created) !==
        codingAssetIdentity(fs.fstatSync(output, { bigint: true })) ||
      assetNames(output, 1).length !== 0
    )
      throw Error('stale_coding_asset');
    const intent = fs.openSync(join(assetFdPath(output), '.incomplete'), 'wx', 0o600);
    try {
      write(
        intent,
        Buffer.from(
          JSON.stringify({
            format: 1,
            manifestHash: manifest.hash,
            sourceStateHash: fresh.sourceStateHash,
          }),
        ),
      );
      fs.fsyncSync(intent);
    } finally {
      fs.closeSync(intent);
    }
    fs.fsyncSync(output);
    fs.mkdirSync(join(assetFdPath(output), 'blobs'), { mode: 0o700 });
    blobs = fs.openSync(join(assetFdPath(output), 'blobs'), assetDirectoryFlags);
    source = fs.openSync(fresh.root, assetDirectoryFlags);
    if (
      codingAssetMount(source) !== fresh.sourceMount ||
      codingAssetIdentity(fs.fstatSync(source, { bigint: true })) !== fresh.sourceEntries[0]?.[1]
    )
      throw Error('stale_coding_asset');
    const buffer = Buffer.alloc(1048576),
      copied = new Set<string>(),
      states = new Map(fresh.sourceEntries);
    for (const entry of manifest.entries) {
      if (entry.kind !== 'file' || copied.has(entry.sha256)) continue;
      const input = sourceFile(source, fresh, entry.path, states);
      let file: number | undefined;
      try {
        const before = codingAssetIdentity(fs.fstatSync(input, { bigint: true }));
        file = fs.openSync(join(assetFdPath(blobs), entry.sha256), 'wx', 0o600);
        const hash = createHash('sha256');
        let position = 0;
        while (position < entry.bytes) {
          const count = fs.readSync(
            input,
            buffer,
            0,
            Math.min(buffer.length, entry.bytes - position),
            position,
          );
          if (!count) throw Error('stale_coding_asset');
          const chunk = buffer.subarray(0, count);
          hash.update(chunk);
          write(file, chunk);
          position += count;
        }
        if (
          codingAssetIdentity(fs.fstatSync(input, { bigint: true })) !== before ||
          hash.digest('hex') !== entry.sha256
        )
          throw Error('stale_coding_asset');
        checkAssetPath(input, join(fresh.root, entry.path));
        fs.fsyncSync(file);
        copied.add(entry.sha256);
      } finally {
        fs.closeSync(input);
        if (file !== undefined) fs.closeSync(file);
      }
      checkAssetPath(output, destination);
    }
    fs.fsyncSync(blobs);
    const after = recapture(fresh, manifest);
    if (after.sourceStateHash !== fresh.sourceStateHash || after.manifest.hash !== manifest.hash)
      throw Error('stale_coding_asset');
    verifyAssetBlobs(blobs, manifest);
    const record = fs.openSync(join(assetFdPath(output), 'manifest.json'), 'wx', 0o600);
    try {
      write(record, Buffer.from(JSON.stringify(manifest)));
      fs.fsyncSync(record);
    } finally {
      fs.closeSync(record);
    }
    checkAssetPath(output, destination);
    fs.fsyncSync(output);
    fs.unlinkSync(join(assetFdPath(output), '.incomplete'));
    fs.fsyncSync(output);
    checkAssetPath(parent, dirname(destination));
    fs.fsyncSync(parent);
    return verifyCodingAssetArchive(destination);
  } finally {
    if (source !== undefined) fs.closeSync(source);
    if (blobs !== undefined) fs.closeSync(blobs);
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(parent);
  }
}
export function verifyCodingAssetArchive(directory: string): CodingAssetManifest {
  const root = privateAssetDirectory(directory);
  let blobs: number | undefined, record: number | undefined;
  try {
    const before = codingAssetIdentity(fs.fstatSync(root, { bigint: true }));
    if (JSON.stringify(assetNames(root, 4)) !== JSON.stringify(['blobs', 'manifest.json']))
      throw Error('invalid_coding_asset_archive');
    record = fs.openSync(
      join(assetFdPath(root), 'manifest.json'),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(record, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size > 33554432n ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (stat.mode & 0o077n) !== 0n
    )
      throw Error('invalid_coding_asset_archive');
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(record, buffer, offset, buffer.length - offset, offset);
      if (!count) throw Error('invalid_coding_asset_archive');
      offset += count;
    }
    if (codingAssetIdentity(stat) !== codingAssetIdentity(fs.fstatSync(record, { bigint: true })))
      throw Error('stale_coding_asset');
    let manifest: CodingAssetManifest;
    try {
      manifest = validateCodingAssetManifest(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown,
      );
    } catch {
      throw Error('invalid_coding_asset_archive');
    }
    blobs = privateAssetChild(root, 'blobs', join(directory, 'blobs'));
    verifyAssetBlobs(blobs, manifest);
    checkAssetPath(root, directory);
    if (codingAssetIdentity(fs.fstatSync(root, { bigint: true })) !== before)
      throw Error('stale_coding_asset');
    return manifest;
  } finally {
    if (record !== undefined) fs.closeSync(record);
    if (blobs !== undefined) fs.closeSync(blobs);
    fs.closeSync(root);
  }
}
