import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { assetDirectoryFlags, assetFdPath, assetNames, checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
import { readGitDescriptor, unsupportedGitStorage } from './coding-git-storage.js';
export const gitDigest = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
interface Observation {
  fd: number;
  path: string;
  identity: string;
  mount: string;
  bytes?: { length: number; sha256: string };
  names?: { count: number; sha256: string };
}
/** Private descriptors and byte witnesses never escape to the consumer's mutable DTO. */
export class GitEvidenceObserver {
  readonly #seen = new Map<string, Observation>();
  readonly #absent = new Set<string>();
  directory(path: string, mount?: string): number | null {
    const previous = this.#seen.get(path);
    if (previous) return previous.fd;
    if (fs.realpathSync(dirname(path)) !== dirname(path)) return unsupportedGitStorage();
    let fd: number;
    try {
      fd = fs.openSync(path, assetDirectoryFlags);
    } catch (error) {
      if (!missing(error)) throw error;
      this.#absent.add(path);
      return null;
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true }),
        actualMount = codingAssetMount(fd);
      if (
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stat.mode & 0o7022n) !== 0n ||
        (mount !== undefined && actualMount !== mount)
      )
        return unsupportedGitStorage();
      checkAssetPath(fd, path);
      this.#seen.set(path, { fd, path, identity: codingAssetIdentity(stat), mount: actualMount });
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  child(parent: number, name: string): number | null {
    const path = fs.realpathSync(assetFdPath(parent));
    return this.directory(join(path, name), codingAssetMount(parent));
  }
  file(parent: number, name: string, max: number): Buffer | null {
    const path = join(fs.realpathSync(assetFdPath(parent)), name);
    let metadata: number;
    try {
      metadata = fs.openSync(join(assetFdPath(parent), name), 0x200000 | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (!missing(error)) throw error;
      this.#absent.add(path);
      return null;
    }
    try {
      const stat = fs.fstatSync(metadata, { bigint: true }),
        mount = codingAssetMount(metadata);
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stat.mode & 0o7022n) !== 0n ||
        stat.size > BigInt(max) ||
        mount !== codingAssetMount(parent)
      )
        return unsupportedGitStorage();
      checkAssetPath(metadata, path);
      const fd = fs.openSync(
        join(assetFdPath(parent), name),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        if (
          codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) !== codingAssetIdentity(stat) ||
          codingAssetMount(fd) !== mount
        )
          throw Error('stale_coding_git_storage');
        const bytes = readGitDescriptor(fd, max);
        checkAssetPath(fd, path);
        this.#seen.set(path, {
          fd,
          path,
          identity: codingAssetIdentity(stat),
          mount,
          bytes: { length: bytes.length, sha256: gitDigest(bytes) },
        });
        return bytes;
      } catch (error) {
        fs.closeSync(fd);
        throw error;
      }
    } finally {
      fs.closeSync(metadata);
    }
  }
  metadata(parent: number, name: string, max: number): boolean {
    const path = join(fs.realpathSync(assetFdPath(parent)), name);
    let fd: number;
    try {
      fd = fs.openSync(join(assetFdPath(parent), name), 0x200000 | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (!missing(error)) throw error;
      this.#absent.add(path);
      return false;
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true }),
        mount = codingAssetMount(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stat.mode & 0o7022n) !== 0n ||
        stat.size > BigInt(max) ||
        mount !== codingAssetMount(parent)
      )
        return unsupportedGitStorage();
      checkAssetPath(fd, path);
      this.#seen.set(path, { fd, path, identity: codingAssetIdentity(stat), mount });
      return true;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  names(fd: number, limit: number): string[] {
    const record = this.#seen.get(fs.realpathSync(assetFdPath(fd)))!;
    const names = assetNames(fd, limit);
    record.names = { count: names.length, sha256: gitDigest(JSON.stringify(names)) };
    return names;
  }
  verify(): void {
    for (const record of this.#seen.values()) {
      const current = fs.openSync(record.path, 0x200000 | fs.constants.O_NOFOLLOW);
      try {
        if (
          codingAssetIdentity(fs.fstatSync(current, { bigint: true })) !== record.identity ||
          codingAssetMount(current) !== record.mount
        )
          throw Error('stale_coding_git_storage');
      } finally {
        fs.closeSync(current);
      }
      checkAssetPath(record.fd, record.path);
      if (
        codingAssetIdentity(fs.fstatSync(record.fd, { bigint: true })) !== record.identity ||
        codingAssetIdentity(fs.lstatSync(record.path, { bigint: true })) !== record.identity ||
        codingAssetMount(record.fd) !== record.mount
      )
        throw Error('stale_coding_git_storage');
      if (
        record.bytes &&
        gitDigest(readGitDescriptor(record.fd, record.bytes.length)) !== record.bytes.sha256
      )
        throw Error('stale_coding_git_storage');
      if (
        record.names &&
        gitDigest(JSON.stringify(assetNames(record.fd, record.names.count + 1))) !==
          record.names.sha256
      )
        throw Error('stale_coding_git_storage');
    }
    for (const path of this.#absent) {
      try {
        fs.lstatSync(path);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      throw Error('stale_coding_git_storage');
    }
  }
  close(): void {
    for (const { fd } of this.#seen.values()) fs.closeSync(fd);
    this.#seen.clear();
  }
}
