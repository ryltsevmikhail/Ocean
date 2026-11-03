import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { CodingAssetManifest } from '@runnets/domain';
import { assetFdPath } from './coding-asset-io.js';
import { codingAssetIdentity } from './coding-asset-state.js';
import { ProfileBackupOutput, profileHash } from './profile-backup-output.js';
import { verifyCodingAssetArchive } from './coding-asset-archive.js';

export interface LineageFileCapture {
  readonly manifest: CodingAssetManifest;
  readonly bytes: Buffer;
}
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
/** One exact private or owner-selected file, bounded before any body read. Links are refused. */
export function readLineageFile(path: string, name: string, limit: number): LineageFileCapture {
  const fd = fs.openSync(path, flags);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(limit) ||
      before.uid !== BigInt(process.getuid?.() ?? -1)
    )
      throw Error('invalid_rebind_output');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('stale_coding_asset');
      offset += count;
    }
    const after = fs.lstatSync(path, { bigint: true });
    if (
      codingAssetIdentity(after) !== codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) ||
      codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== codingAssetIdentity(before)
    )
      throw Error('stale_coding_asset');
    const body = {
      format: 1 as const,
      entries: [
        { path: '', kind: 'directory' as const, mode: 0o700 },
        {
          path: name,
          kind: 'file' as const,
          mode: Number(before.mode & 0o777n),
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
      bytes: bytes.length,
    };
    return { manifest: { ...body, hash: profileHash(body) }, bytes };
  } finally {
    fs.closeSync(fd);
  }
}
/** New private one-file asset archive; failure retains its incomplete bytes as evidence. */
export function archiveLineageFile(capture: LineageFileCapture, destination: string): string {
  const output = new ProfileBackupOutput(destination);
  try {
    fs.mkdirSync(join(assetFdPath(output.fd), 'blobs'), { mode: 0o700 });
    const entry = capture.manifest.entries[1];
    if (!entry || entry.kind !== 'file') throw Error('invalid_rebind_output');
    const fd = fs.openSync(join(assetFdPath(output.fd), 'blobs', entry.sha256), 'wx', 0o600);
    try {
      fs.writeFileSync(fd, capture.bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    output.write('manifest.json', capture.manifest);
    output.publish();
  } finally {
    output.close();
  }
  return verifyCodingAssetArchive(destination).hash;
}
