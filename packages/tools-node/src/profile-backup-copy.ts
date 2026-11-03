import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkProfileArchiveFile } from './profile-archive-context.js';
import { codingAssetIdentity } from './coding-asset-state.js';
import { assetFdPath } from './coding-asset-io.js';
import { assertProfileBackupOutput, type ProfileBackupOutput } from './profile-backup-output.js';
/** Host copies verified SQLite through the original wholearchive metadata, without a pathname copy race. */
export function copyProfileBackupDatabase(
  source: string,
  output: ProfileBackupOutput,
  expected: { bytes: number; sha256: string },
): void {
  assertProfileBackupOutput(output);
  const fd = fs.openSync(
    source,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let target: number | undefined;
  try {
    checkProfileArchiveFile(fd);
    const before = codingAssetIdentity(fs.fstatSync(fd, { bigint: true }));
    target = fs.openSync(join(assetFdPath(output.fd), 'runtime.sqlite'), 'wx', 0o600);
    const buffer = Buffer.alloc(1048576),
      hash = createHash('sha256');
    let offset = 0;
    while (offset < expected.bytes) {
      output.check();
      checkProfileArchiveFile(fd);
      const n = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, expected.bytes - offset),
        offset,
      );
      if (!n) throw Error('stale_coding_asset');
      hash.update(buffer.subarray(0, n));
      let written = 0;
      while (written < n) {
        const count = fs.writeSync(target, buffer, written, n - written);
        if (!count) throw Error('profile_backup_write_failed');
        written += count;
      }
      offset += n;
    }
    checkProfileArchiveFile(fd);
    output.check();
    if (
      codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== before ||
      hash.digest('hex') !== expected.sha256
    )
      throw Error('stale_coding_asset');
    fs.fsyncSync(target);
  } finally {
    fs.closeSync(fd);
    if (target !== undefined) fs.closeSync(target);
  }
}
