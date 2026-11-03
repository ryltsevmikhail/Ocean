import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  readFileSync,
  readlinkSync,
  opendirSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { assertLocalPrivate, type LocalRuntimePaths } from '@runnets/tools-node';
import { join } from 'node:path';

const nofollow = constants.O_NOFOLLOW;
const pathOnly = 0x200000 | nofollow; // Linux O_PATH, including for special files.
export function mount(fd: number) {
  const id = /^mnt_id:\s+(\d+)$/m.exec(readFileSync('/proc/self/fdinfo/' + fd, 'utf8'))?.[1];
  if (!id) throw Error('endpoint_changed');
  return id;
}
function key(s: BigIntStats, mountId: string) {
  return [mountId, s.dev, s.ino, s.birthtimeNs, s.mode, s.uid, s.gid].join(':');
}
function privateIdentity(path: string, kind: 'file' | 'directory') {
  assertLocalPrivate(path, kind);
  const fd = openSync(path, pathOnly);
  try {
    const id = mount(fd);
    return { id, key: key(fstatSync(fd, { bigint: true }), id) };
  } finally {
    closeSync(fd);
  }
}
export function profileKey(paths: LocalRuntimePaths) {
  const profile = privateIdentity(paths.profile, 'directory');
  const database = privateIdentity(join(paths.profile, 'runtime.sqlite'), 'file');
  if (database.id !== profile.id) throw Error('endpoint_changed');
  return JSON.stringify([profile.key, database.key]);
}
export class EndpointLayout {
  readonly paths: LocalRuntimePaths;
  readonly directoryFd: number;
  readonly at: string;
  readonly identity: string;
  constructor(paths: LocalRuntimePaths, originalProfile: string) {
    this.paths = paths;
    this.directoryFd = openSync(paths.directory, constants.O_DIRECTORY | nofollow);
    this.at = '/proc/self/fd/' + this.directoryFd;
    try {
      if (profileKey(paths) !== originalProfile) throw Error('endpoint_changed');
      this.identity = this.layout();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private layout(): string {
    const { root, directory, profileId } = this.paths;
    const parent = privateIdentity(root, 'directory');
    const endpoint = privateIdentity(directory, 'directory');
    if (
      parent.id !== endpoint.id ||
      endpoint.key !== key(fstatSync(this.directoryFd, { bigint: true }), mount(this.directoryFd))
    )
      throw Error('endpoint_changed');
    return JSON.stringify([
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      readlinkSync('/proc/self/ns/mnt'),
      profileId,
      directory,
      profileKey(this.paths),
      parent.key,
      endpoint.key,
    ]);
  }
  check(): void {
    if (this.layout() !== this.identity) throw Error('endpoint_changed');
  }
  entries(expected: string[]): void {
    this.check();
    const remaining = new Set(expected);
    const dir = opendirSync(this.at);
    try {
      let entry;
      while ((entry = dir.readSync()))
        if (!remaining.delete(entry.name)) throw Error('endpoint_exists');
      if (remaining.size) throw Error('endpoint_exists');
    } finally {
      dir.closeSync();
    }
  }
  sync(): void {
    fsyncSync(this.directoryFd);
  }
  close(): void {
    closeSync(this.directoryFd);
  }
  pin(name: string): number {
    return openSync(join(this.at, name), pathOnly);
  }
  matches(name: string, fd: number): boolean {
    let named: number;
    try {
      named = this.pin(name);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
    try {
      return (
        key(fstatSync(named, { bigint: true }), mount(named)) ===
          key(fstatSync(fd, { bigint: true }), mount(fd)) && mount(fd) === mount(this.directoryFd)
      );
    } finally {
      closeSync(named);
    }
  }
  unlink(name: string, fd: number): void {
    this.check();
    if (!this.matches(name, fd)) throw Error('endpoint_changed');
    unlinkSync(join(this.at, name));
  }
  /** Opaque bounded bytes from the verified regular inode; never parse a predecessor credential. */
  proof(socket: number, descriptor: number, expected?: Buffer): string {
    this.entries(['connection.json', 'runtime.sock']);
    // Earlier binders could attest a foreign socket through a relay or a copied
    // abstract address in another network namespace. Their proofs stay inert.
    const hash = createHash('sha256')
      .update('ocean-endpoint-mutual-ucred-v1\0')
      .update(this.identity);
    for (const [name, fd] of [
      ['runtime.sock', socket],
      ['connection.json', descriptor],
    ] as const) {
      const s = fstatSync(fd, { bigint: true });
      if (
        !this.matches(name, fd) ||
        s.nlink !== 1n ||
        (s.mode & 0o7777n) !== 0o600n ||
        s.uid !== BigInt(process.getuid!()) ||
        (fd === socket ? !s.isSocket() : !s.isFile() || s.size > 4096n)
      )
        throw Error('endpoint_changed');
      hash.update(
        JSON.stringify([key(s, mount(fd)), String(s.ctimeNs), String(s.mtimeNs), String(s.size)]),
      );
      if (fd === descriptor) {
        const input = openSync('/proc/self/fd/' + fd, constants.O_RDONLY | constants.O_NONBLOCK);
        const bytes = Buffer.alloc(4097);
        try {
          const length = readSync(input, bytes, 0, bytes.length, 0);
          const content = bytes.subarray(0, length);
          if (length !== Number(s.size) || (expected && !content.equals(expected)))
            throw Error('endpoint_changed');
          hash.update(content);
        } finally {
          bytes.fill(0);
          closeSync(input);
        }
      }
    }
    return hash.digest('hex');
  }
}
