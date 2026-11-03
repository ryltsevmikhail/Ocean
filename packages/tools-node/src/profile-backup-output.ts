import * as fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  assetDirectoryFlags,
  assetFdPath,
  checkAssetPath,
  privateAssetChild,
} from './coding-asset-io.js';
import { codingAssetMount } from './coding-asset-state.js';
export const profileHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (fd: number) => {
  const s = fs.fstatSync(fd, { bigint: true });
  return [s.dev, s.ino, s.mode, s.uid, s.gid, codingAssetMount(fd)].join(':');
};
const issued = new WeakSet<ProfileBackupOutput>();
export class ProfileBackupOutput {
  readonly path: string;
  readonly fd: number;
  readonly #parent: number;
  readonly #rootIdentity: string;
  readonly #parentIdentity: string;
  constructor(path: string) {
    if (resolve(path) !== path || fs.realpathSync(dirname(path)) !== dirname(path))
      throw Error('invalid_profile_backup_destination');
    this.path = path;
    this.#parent = fs.openSync(dirname(path), assetDirectoryFlags);
    this.#parentIdentity = identity(this.#parent);
    let root: number | undefined;
    try {
      checkAssetPath(this.#parent, dirname(path));
      fs.mkdirSync(join(assetFdPath(this.#parent), basename(path)), { mode: 0o700 });
      root = privateAssetChild(this.#parent, basename(path), path);
      this.fd = root;
      this.#rootIdentity = identity(root);
      this.write('.incomplete', { format: 2 });
      fs.fsyncSync(root);
      fs.fsyncSync(this.#parent);
      this.check();
      issued.add(this);
    } catch (error) {
      if (root !== undefined) fs.closeSync(root);
      fs.closeSync(this.#parent);
      throw error;
    }
  }
  check(): void {
    checkAssetPath(this.#parent, dirname(this.path));
    checkAssetPath(this.fd, this.path);
    for (const [path, expected] of [
      [dirname(this.path), this.#parentIdentity],
      [this.path, this.#rootIdentity],
    ]) {
      const fd = fs.openSync(path!, assetDirectoryFlags);
      try {
        if (identity(fd) !== expected) throw Error('stale_coding_asset');
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  write(name: string, value: unknown): void {
    this.writeBytes(name, Buffer.from(JSON.stringify(value)));
  }
  writeBytes(name: string, value: Buffer): void {
    if (!name || basename(name) !== name || ['.', '..'].includes(name))
      throw Error('invalid_profile_backup');
    this.check();
    const fd = fs.openSync(join(assetFdPath(this.fd), name), 'wx', 0o600);
    try {
      fs.writeFileSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.check();
  }
  publish(): void {
    this.check();
    fs.fsyncSync(this.fd);
    fs.unlinkSync(join(assetFdPath(this.fd), '.incomplete'));
    fs.fsyncSync(this.fd);
    fs.fsyncSync(this.#parent);
    this.check();
  }
  close(): void {
    fs.closeSync(this.fd);
    fs.closeSync(this.#parent);
  }
}

export function assertProfileBackupOutput(output: ProfileBackupOutput): void {
  if (!issued.has(output)) throw Error('invalid_profile_backup_output');
  output.check();
}

export function freezeProfileValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeProfileValue(child);
    Object.freeze(value);
  }
  return value;
}
