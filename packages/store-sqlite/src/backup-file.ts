import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
/** Bounded-memory digest of a stable regular snapshot file. No path links or shared inodes. */
export function snapshotFileHash(path: string): string {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw Error('snapshot_mismatch');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(1048576);
    let position = 0;
    while (position < Number(before.size)) {
      const count = readSync(
        file,
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - position),
        position,
      );
      if (count === 0) throw Error('snapshot_mismatch');
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    const after = fstatSync(file, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.mode !== after.mode ||
      after.nlink !== 1n
    )
      throw Error('snapshot_mismatch');
    return hash.digest('hex');
  } finally {
    closeSync(file);
  }
}
