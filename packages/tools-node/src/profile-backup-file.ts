import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { profileBackupSession } from './profile-backup-session.js';
import { codingAssetIdentity, codingAssetMount, hashAssetBytes } from './coding-asset-state.js';
import { assetDirectoryFlags, assetFdPath, checkAssetPath } from './coding-asset-io.js';
/** Preserve classification JSON even when it selects no body: later consumers cannot redefine membership. */
export function retainProfileClassification(file: number, path: string, bytes: Buffer): void {
  const session = profileBackupSession.getStore();
  if (!session) return;
  const fd = fs.openSync(assetFdPath(file), fs.constants.O_RDONLY),
    parent = fs.openSync(dirname(path), assetDirectoryFlags);
  const state = codingAssetIdentity(fs.fstatSync(file, { bigint: true })),
    parentState = codingAssetIdentity(fs.fstatSync(parent, { bigint: true })),
    mount = codingAssetMount(file),
    digest = createHash('sha256').update(bytes).digest('hex'),
    length = bytes.length;
  let transferred = false;
  const metadata = () => {
    checkAssetPath(parent, dirname(path));
    checkAssetPath(fd, path);
    const current = fs.openSync(path, 0x200000 | fs.constants.O_NOFOLLOW);
    try {
      if (
        codingAssetIdentity(fs.fstatSync(current, { bigint: true })) !== state ||
        codingAssetMount(current) !== mount ||
        codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== state ||
        codingAssetIdentity(fs.fstatSync(parent, { bigint: true })) !== parentState
      )
        throw Error('stale_coding_asset');
    } finally {
      fs.closeSync(current);
    }
  };
  try {
    metadata();
    transferred = true;
    session.retain('classification:' + path, digest, {
      metadata,
      bytes: () => {
        metadata();
        if (hashAssetBytes(fd, length, Buffer.alloc(1048576)) !== digest)
          throw Error('stale_coding_asset');
      },
      close: () => {
        fs.closeSync(fd);
        fs.closeSync(parent);
      },
    });
  } catch (error) {
    if (!transferred) {
      fs.closeSync(fd);
      fs.closeSync(parent);
    }
    throw error;
  }
}
