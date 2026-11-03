import * as fs from 'node:fs';
import { join } from 'node:path';
import { assertPrivate } from './private-files.js';
const identity = (stat: fs.BigIntStats) =>
  [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
const mount = (fd: number) =>
  /^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))?.[1];
/** Bounded routing only: format 2 still independently verifies its entire envelope. */
export function readSnapshotManifest(directory: string): unknown {
  const path = join(directory, 'snapshot.json');
  assertPrivate(directory, true);
  assertPrivate(path, false);
  const root = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  let fd: number | undefined;
  try {
    const rootState = identity(fs.fstatSync(root, { bigint: true })),
      rootMount = mount(root);
    fd = fs.openSync(
      '/proc/self/fd/' + root + '/snapshot.json',
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(fd, { bigint: true }),
      original = identity(before);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o077n) !== 0n ||
      before.size > 33554432n ||
      !rootMount ||
      mount(fd) !== rootMount
    )
      throw Error('invalid_backup');
    const check = () => {
      assertPrivate(directory, true);
      assertPrivate(path, false);
      if (
        identity(fs.fstatSync(root, { bigint: true })) !== rootState ||
        identity(fs.lstatSync(directory, { bigint: true })) !== rootState ||
        fs.realpathSync('/proc/self/fd/' + root) !== directory ||
        mount(root) !== rootMount ||
        identity(fs.fstatSync(fd!, { bigint: true })) !== original ||
        identity(fs.lstatSync(path, { bigint: true })) !== original ||
        fs.realpathSync('/proc/self/fd/' + fd) !== path ||
        mount(fd!) !== rootMount
      )
        throw Error('invalid_backup');
    };
    check();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error('invalid_backup');
      offset += count;
    }
    check();
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.closeSync(root);
  }
}
