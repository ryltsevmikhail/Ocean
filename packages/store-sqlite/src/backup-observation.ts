import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
const identity = (s: fs.BigIntStats) =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const mount = (fd: number) =>
  /^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))?.[1];
/** Frozen database witness spans all capture/finalizer consumers without accepting a fresh baseline. */
export function holdBackupObservation(path: string) {
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true }),
      original = identity(before),
      originalMount = mount(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size > 2147483648n ||
      !originalMount
    )
      throw Error('snapshot_mismatch');
    const metadata = () => {
      const current = fs.openSync(path, 0x200000 | fs.constants.O_NOFOLLOW);
      try {
        if (
          identity(fs.fstatSync(current, { bigint: true })) !== original ||
          mount(current) !== originalMount ||
          identity(fs.fstatSync(fd, { bigint: true })) !== original ||
          mount(fd) !== originalMount ||
          fs.realpathSync('/proc/self/fd/' + fd) !== path
        )
          throw Error('snapshot_mismatch');
      } finally {
        fs.closeSync(current);
      }
    };
    const read = () => {
      metadata();
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(1048576);
      let offset = 0;
      while (offset < Number(before.size)) {
        const n = fs.readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, Number(before.size) - offset),
          offset,
        );
        if (!n) throw Error('snapshot_mismatch');
        hash.update(buffer.subarray(0, n));
        offset += n;
      }
      metadata();
      return hash.digest('hex');
    };
    const hash = read();
    return {
      hash,
      metadata,
      verify: () => {
        if (read() !== hash) throw Error('snapshot_mismatch');
      },
      close: () => fs.closeSync(fd),
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
