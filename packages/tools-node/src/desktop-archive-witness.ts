import * as fs from 'node:fs';
import { join } from 'node:path';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-scan.js';
import { assetFdPath, checkAssetPath } from './coding-asset-io.js';
export const desktopArchiveState = (fd: number) =>
  codingAssetIdentity(fs.fstatSync(fd, { bigint: true })) + ':' + codingAssetMount(fd);
/** Metadata observations are retained across all byte consumers, including materialization. */
export class DesktopArchiveWitnesses {
  private readonly directories: { fd: number; path: string; state: string }[] = [];
  private readonly files: { parent: number; name: string; path: string; state: string }[] = [];
  private readonly mount: string;
  constructor(root: number, path: string) {
    this.mount = codingAssetMount(root);
    this.directory(root, path);
  }
  directory(fd: number, path: string): void {
    const s = fs.fstatSync(fd, { bigint: true }),
      mount = codingAssetMount(fd);
    if (
      !s.isDirectory() ||
      s.uid !== BigInt(process.getuid!()) ||
      (s.mode & 0o777n) !== 0o700n ||
      mount !== this.mount
    )
      throw Error('invalid_desktop_archive');
    this.directories.push({ fd, path, state: codingAssetIdentity(s) + ':' + mount });
  }
  file(parent: number, name: string, path: string, limit: number, size?: number): string {
    const fd = fs.openSync(join(assetFdPath(parent), name), 0x200000 | fs.constants.O_NOFOLLOW);
    try {
      const s = fs.fstatSync(fd, { bigint: true }),
        mount = codingAssetMount(fd);
      if (
        !s.isFile() ||
        s.nlink !== 1n ||
        s.uid !== BigInt(process.getuid!()) ||
        (s.mode & 0o777n) !== 0o600n ||
        s.size > BigInt(limit) ||
        (size !== undefined && s.size !== BigInt(size)) ||
        mount !== this.mount
      )
        throw Error('invalid_desktop_archive');
      const state = codingAssetIdentity(s) + ':' + mount;
      this.files.push({ parent, name, path, state });
      return state;
    } finally {
      fs.closeSync(fd);
    }
  }
  private current(path: string, state: string): void {
    // realpath and the original descriptor alone do not detect a later overmount.
    const fd = fs.openSync(path, 0x200000 | fs.constants.O_NOFOLLOW);
    try {
      if (desktopArchiveState(fd) !== state) throw Error('stale_coding_asset');
    } finally {
      fs.closeSync(fd);
    }
  }
  check(): void {
    for (const d of this.directories) {
      if (desktopArchiveState(d.fd) !== d.state) throw Error('stale_coding_asset');
      checkAssetPath(d.fd, d.path);
      this.current(d.path, d.state);
    }
    for (const f of this.files) {
      this.current(join(assetFdPath(f.parent), f.name), f.state);
      this.current(f.path, f.state);
    }
  }
}
