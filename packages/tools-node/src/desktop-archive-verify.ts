import { validDesktopBindingShape } from './desktop-identity.js';
import { checkProfileArchiveFile } from './profile-archive-context.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CodingAssetManifest } from '@runnets/domain';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-scan.js';
import { DesktopArchiveWitnesses, desktopArchiveState } from './desktop-archive-witness.js';
import {
  privateAssetDirectory,
  privateAssetChild,
  assetFdPath,
  assetNames,
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
    checkProfileArchiveFile(fd);
    const before = fs.fstatSync(fd, { bigint: true }),
      state = codingAssetIdentity(before) + ':' + codingAssetMount(fd);
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
      desktopArchiveState(fd) !== state ||
      codingAssetIdentity(fs.lstatSync(path, { bigint: true })) !== codingAssetIdentity(before) ||
      (expectedHash && createHash('sha256').update(data).digest('hex') !== expectedHash)
    )
      throw Error('stale_coding_asset');
    return data;
  } finally {
    fs.closeSync(fd);
  }
}
function preflight(
  blobs: number,
  manifest: CodingAssetManifest,
  witnesses: DesktopArchiveWitnesses,
  directory: string,
) {
  const files = new Map(
    manifest.entries.flatMap((e) => (e.kind === 'file' ? [[e.sha256, e.bytes] as const] : [])),
  );
  if (assetNames(blobs, files.size + 1).join() !== [...files.keys()].sort().join())
    throw Error('invalid_desktop_archive');
  const states = new Map<string, string>();
  for (const [name, size] of files)
    states.set(
      name,
      witnesses.file(blobs, name, join(directory, 'assets', 'blobs', name), size, size),
    );
  return { files, states };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freeze(v);
    Object.freeze(value);
  }
  return value;
}
export function verifyDesktopArchive(
  directory: string,
  incomplete = false,
  consume?: (catalog: DesktopAssetCatalog) => void,
): DesktopAssetCatalog {
  const root = privateAssetDirectory(directory);
  let assets: number | undefined, blobs: number | undefined;
  try {
    const witnesses = new DesktopArchiveWitnesses(root, directory);
    if (
      assetNames(root, 4).join() !==
      (incomplete ? '.incomplete,assets,catalog.json' : 'assets,catalog.json')
    )
      throw Error('invalid_desktop_archive');
    const catalogState = witnesses.file(
      root,
      'catalog.json',
      join(directory, 'catalog.json'),
      16777216,
    );
    const original = readDesktopArchiveFile(
        root,
        'catalog.json',
        16777216,
        undefined,
        catalogState,
      ),
      catalog = JSON.parse(original.toString('utf8')) as DesktopAssetCatalog;
    const { hash: digest, ...body } = catalog;
    if (
      catalog.format !== 1 ||
      hash(body) !== digest ||
      !validDesktopBindingShape(catalog.inventory?.binding)
    )
      throw Error('invalid_desktop_archive');
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
    witnesses.directory(assets, join(directory, 'assets'));
    const manifestState = witnesses.file(
      assets,
      'manifest.json',
      join(directory, 'assets', 'manifest.json'),
      16777216,
    );
    const storedManifest = readDesktopArchiveFile(
      assets,
      'manifest.json',
      16777216,
      undefined,
      manifestState,
    );
    if (hash(JSON.parse(storedManifest.toString('utf8'))) !== hash(manifest))
      throw Error('invalid_desktop_archive');
    blobs = privateAssetChild(assets, 'blobs', join(directory, 'assets', 'blobs'));
    if (codingAssetMount(blobs) !== codingAssetMount(root)) throw Error('invalid_desktop_archive');
    witnesses.directory(blobs, join(directory, 'assets', 'blobs'));
    const before = preflight(blobs, manifest, witnesses, directory);
    witnesses.check();
    const readBlob = (name: string, size: number) =>
      readDesktopArchiveFile(blobs!, name, size, name, before.states.get(name));
    for (const [name, size] of before.files) readBlob(name, size);
    checkDesktopEvidence(catalog.inventory, manifest, (path) => {
      const entry = manifest.entries.find((e) => e.path === path);
      if (!entry || entry.kind !== 'file' || entry.bytes > 131072)
        throw Error('desktop_asset_corrupted');
      return readBlob(entry.sha256, entry.bytes);
    });
    const check = () => {
      witnesses.check();
      if (
        assetNames(root, 4).join() !==
          (incomplete ? '.incomplete,assets,catalog.json' : 'assets,catalog.json') ||
        assetNames(assets!, 3).join() !== 'blobs,manifest.json' ||
        assetNames(blobs!, before.files.size + 1).join() !==
          [...before.files.keys()].sort().join() ||
        !readDesktopArchiveFile(root, 'catalog.json', 16777216, undefined, catalogState).equals(
          original,
        ) ||
        !readDesktopArchiveFile(
          assets!,
          'manifest.json',
          16777216,
          undefined,
          manifestState,
        ).equals(storedManifest)
      )
        throw Error('stale_coding_asset');
      for (const [name, size] of before.files) readBlob(name, size);
      // Compare every original private identity and CURRENT path mount after the LAST read.
      witnesses.check();
    };
    check();
    if (consume) {
      consume(freeze(catalog));
      check();
    }
    return freeze(catalog);
  } finally {
    if (blobs !== undefined) fs.closeSync(blobs);
    if (assets !== undefined) fs.closeSync(assets);
    fs.closeSync(root);
  }
}
