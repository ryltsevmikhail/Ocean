import { desktopAliasGuards } from './desktop-preparation-alias.js';
import * as fs from 'node:fs';
import { withDesktopRoot } from './desktop-root.js';
import { createHash } from 'node:crypto';
import type { DesktopAssetInventory, CodingAssetManifest } from '@runnets/domain';
import {
  captureAssetTreeAt,
  checkAssetTreeAt,
  codingAssetMount,
  type CodingAssetCapture,
} from './coding-asset-scan.js';
import { readDesktopSource } from './desktop-source-read.js';
import { checkDesktopEvidence } from './desktop-evidence.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function desktopRootIdentity(root: string): string {
  if (fs.realpathSync(root) !== root) throw Error('desktop_binding_mismatch');
  const fd = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const s = fs.fstatSync(fd, { bigint: true });
    if (s.uid !== BigInt(process.getuid!()) || (s.mode & 0o777n) !== 0o700n)
      throw Error('desktop_binding_mismatch');
    return [s.dev, s.ino, s.uid, s.gid, s.mode, codingAssetMount(fd)].join(':');
  } finally {
    fs.closeSync(fd);
  }
}
export interface DesktopAssetCatalog {
  readonly format: 1;
  readonly inventory: DesktopAssetInventory;
  readonly manifest: CodingAssetManifest;
  readonly hash: string;
}
export interface DesktopAssetCapture {
  readonly catalog: DesktopAssetCatalog;
}
const issued = new WeakMap<
  DesktopAssetCapture,
  {
    source: CodingAssetCapture;
    digest: string;
    preparations: ReturnType<typeof checkDesktopEvidence>;
  }
>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
}
export function captureDesktopAssets(input: DesktopAssetInventory): DesktopAssetCapture {
  const inventory = freeze(structuredClone(input));
  const binding = inventory.binding;
  if (!binding) throw Error('desktop_binding_mismatch');
  return withDesktopRoot(binding, (held) => {
    const source = captureAssetTreeAt(
      binding.root,
      { bytes: 134217728, entries: 10000, depth: 3 },
      'desktop',
      held.fd,
      (metadata) => {
        if (
          Buffer.byteLength(
            JSON.stringify({
              format: 1,
              inventory,
              manifest: metadata.manifest,
              hash: '0'.repeat(64),
            }),
          ) > 16777216
        )
          throw Error('desktop_inventory_limit');
        const paths = new Set(metadata.manifest.entries.map((e) => e.path));
        for (const m of inventory.messages)
          if (!paths.has(m.roomId + '/' + m.requestId + '.json'))
            throw Error('desktop_assets_missing');
      },
      undefined,
      (metadata, candidates) => desktopAliasGuards(inventory, metadata, candidates),
    );
    const preparations = freeze(
      checkDesktopEvidence(inventory, source.manifest, (path) => readDesktopSource(source, path)),
    );
    const fd = fs.openSync(
      source.root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      checkAssetTreeAt(source, fd);
    } finally {
      fs.closeSync(fd);
    }
    const body = {
      format: 1 as const,
      inventory: structuredClone(inventory),
      manifest: source.manifest,
    };
    const handle = freeze({ catalog: { ...body, hash: hash(body) } });
    issued.set(handle, { source, digest: hash(handle), preparations });
    return handle;
  });
}
export function checkDesktopCapture(capture: DesktopAssetCapture): void {
  const origin = issued.get(capture);
  if (!origin || hash(capture) !== origin.digest) throw Error('invalid_desktop_capture');
  const fd = fs.openSync(
    origin.source.root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    checkAssetTreeAt(origin.source, fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Internal adoption evidence from the original validated capture, never a fresh pathname read. */
export function capturedDesktopPreparations(capture: DesktopAssetCapture) {
  checkedDesktopCapture(capture);
  return issued.get(capture)!.preparations;
}
export function checkedDesktopCapture(capture: DesktopAssetCapture): CodingAssetCapture {
  const origin = issued.get(capture);
  if (!origin || hash(capture) !== origin.digest) throw Error('invalid_desktop_capture');
  return origin.source;
}
export {
  archiveDesktopAssets,
  verifyDesktopAssetArchive,
  restoreDesktopAssets,
} from './desktop-archive.js';
