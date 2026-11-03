import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CodingAssetManifest } from '@runnets/domain';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-scan.js';
import {
  privateAssetDirectory,
  privateAssetChild,
  assetFdPath,
  assetNames,
  checkAssetPath,
} from './coding-asset-io.js';
import { validateCodingAssetManifest } from './coding-asset-validation.js';
import type { DesktopAssetCatalog } from './desktop-assets.js';
import { checkDesktopEvidence } from './desktop-evidence.js';
import { desktopManifestPolicy } from './desktop-asset-policy.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readDesktopArchiveFile(
  root: number,
  name: string,
  limit: number,
  expectedHash?: string,
  expectedState?: string,
): Buffer {
  const path = join(assetFdPath(root), name),
    fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  try {
    const before = fs.fstatSync(fd, { bigint: true }),
      state = codingAssetIdentity(before);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size > BigInt(limit) ||
      codingAssetMount(fd) !== codingAssetMount(root) ||
      (expectedState && state !== expectedState)
    )
      throw Error('invalid_desktop_archive');
    const data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      const n = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!n) throw Error('invalid_desktop_archive');
      offset += n;
    }
    if (
      codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== state ||
      codingAssetIdentity(fs.lstatSync(path, { bigint: true })) !== state ||
      (expectedHash && createHash('sha256').update(data).digest('hex') !== expectedHash)
    )
      throw Error('stale_coding_asset');
    return data;
  } finally {
    fs.closeSync(fd);
  }
}
function preflight(blobs: number, manifest: CodingAssetManifest) {
  const files = new Map(
    manifest.entries.flatMap((e) => (e.kind === 'file' ? [[e.sha256, e.bytes] as const] : [])),
  );
  if (assetNames(blobs, files.size + 1).join() !== [...files.keys()].sort().join())
    throw Error('invalid_desktop_archive');
  const states = new Map<string, string>();
  for (const [name, size] of files) {
    const fd = fs.openSync(join(assetFdPath(blobs), name), 0x200000 | fs.constants.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(fd, { bigint: true });
      if (
        !s.isFile() ||
        s.nlink !== 1n ||
        s.size !== BigInt(size) ||
        s.uid !== BigInt(process.getuid!()) ||
        (s.mode & 0o777n) !== 0o600n ||
        codingAssetMount(fd) !== codingAssetMount(blobs)
      )
        throw Error('invalid_desktop_archive');
      states.set(name, codingAssetIdentity(s));
    } finally {
      fs.closeSync(fd);
    }
  }
  return { files, states };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
export function verifyDesktopArchive(directory: string, incomplete = false): DesktopAssetCatalog {
  const root = privateAssetDirectory(directory);
  let assets: number | undefined, blobs: number | undefined;
  try {
    const state = codingAssetIdentity(fs.fstatSync(root, { bigint: true }));
    if (
      assetNames(root, 4).join() !==
      (incomplete ? '.incomplete,assets,catalog.json' : 'assets,catalog.json')
    )
      throw Error('invalid_desktop_archive');
    const original = readDesktopArchiveFile(root, 'catalog.json', 16777216),
      catalog = JSON.parse(original.toString('utf8')) as DesktopAssetCatalog;
    const { hash: digest, ...body } = catalog;
    if (catalog.format !== 1 || hash(body) !== digest) throw Error('invalid_desktop_archive');
    const manifest = validateCodingAssetManifest(catalog.manifest);
    if (manifest.entries.length > 10000 || manifest.bytes > 134217728)
      throw Error('invalid_desktop_archive');
    desktopManifestPolicy(manifest.entries);
    assets = privateAssetChild(root, 'assets', join(directory, 'assets'));
    if (
      codingAssetMount(assets) !== codingAssetMount(root) ||
      assetNames(assets, 3).join() !== 'blobs,manifest.json'
    )
      throw Error('invalid_desktop_archive');
    const storedManifest = readDesktopArchiveFile(assets, 'manifest.json', 16777216);
    if (hash(JSON.parse(storedManifest.toString('utf8'))) !== hash(manifest))
      throw Error('invalid_desktop_archive');
    blobs = privateAssetChild(assets, 'blobs', join(directory, 'assets', 'blobs'));
    if (codingAssetMount(blobs) !== codingAssetMount(root)) throw Error('invalid_desktop_archive');
    const before = preflight(blobs, manifest);
    const consume = (name: string, size: number) =>
      readDesktopArchiveFile(blobs!, name, size, name, before.states.get(name));
    for (const [name, size] of before.files) consume(name, size);
    checkDesktopEvidence(catalog.inventory, manifest, (path) => {
      const entry = manifest.entries.find((e) => e.path === path);
      if (!entry || entry.kind !== 'file' || entry.bytes > 131072)
        throw Error('desktop_asset_corrupted');
      return consume(entry.sha256, entry.bytes);
    });
    // All original private witnesses and byte hashes survive the LAST semantic consumer.
    for (const [name, size] of before.files) consume(name, size);
    if (
      JSON.stringify([...preflight(blobs, manifest).states]) !==
        JSON.stringify([...before.states]) ||
      !readDesktopArchiveFile(root, 'catalog.json', 16777216).equals(original) ||
      !readDesktopArchiveFile(assets, 'manifest.json', 16777216).equals(storedManifest)
    )
      throw Error('stale_coding_asset');
    checkAssetPath(root, directory);
    checkAssetPath(assets, join(directory, 'assets'));
    checkAssetPath(blobs, join(directory, 'assets', 'blobs'));
    if (state !== codingAssetIdentity(fs.fstatSync(root, { bigint: true })))
      throw Error('stale_coding_asset');
    return freeze(catalog);
  } finally {
    if (blobs !== undefined) fs.closeSync(blobs);
    if (assets !== undefined) fs.closeSync(assets);
    fs.closeSync(root);
  }
}
