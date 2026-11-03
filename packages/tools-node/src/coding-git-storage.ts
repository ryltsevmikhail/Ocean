import { checkProfileArchiveFile } from './profile-archive-context.js';
import { profileBackupSession } from './profile-backup-session.js';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assetDirectoryFlags, assetFdPath, checkAssetPath } from './coding-asset-io.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-scan.js';
export const unsupportedGitStorage = (): never => {
  throw Error('unsupported_coding_git_storage');
};
/** Metadata only: source object bodies and arbitrary alternate targets are never opened here. */
export function gitObjectStorage(fd: number, canonical: string, oidLength: number): string {
  const states: [string, string][] = [];
  const mount = codingAssetMount(fd);
  let count = 0,
    metadata = 0,
    stored = 0;
  const walk = (directory: number, relative: string): void => {
    checkAssetPath(directory, join(canonical, relative));
    const directoryStat = fs.fstatSync(directory, { bigint: true });
    if (
      codingAssetMount(directory) !== mount ||
      directoryStat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (directoryStat.mode & 0o7000n) !== 0n
    )
      return unsupportedGitStorage();
    const before = codingAssetIdentity(directoryStat);
    const listing = fs.opendirSync(assetFdPath(directory), { bufferSize: 32 });
    const names: string[] = [];
    try {
      for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
        if (++count > 100000 || (metadata += Buffer.byteLength(entry.name) + 256) > 33554432)
          return unsupportedGitStorage();
        names.push(entry.name);
      }
    } finally {
      listing.closeSync();
    }
    for (const name of names.sort()) {
      const path = relative ? relative + '/' + name : name,
        stat = fs.lstatSync(join(assetFdPath(directory), name), { bigint: true });
      if (stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o7000n) !== 0n)
        return unsupportedGitStorage();
      states.push([path, codingAssetIdentity(stat)]);
      if (!relative && (name === 'pack' || name === 'info' || /^[a-f0-9]{2}$/.test(name))) {
        if (!stat.isDirectory()) return unsupportedGitStorage();
        const child = fs.openSync(join(assetFdPath(directory), name), assetDirectoryFlags);
        try {
          if (
            codingAssetIdentity(fs.fstatSync(child, { bigint: true })) !== codingAssetIdentity(stat)
          )
            return unsupportedGitStorage();
          walk(child, path);
        } finally {
          fs.closeSync(child);
        }
      } else {
        const valid =
          relative === 'pack'
            ? new RegExp('^pack-[a-f0-9]{' + oidLength + '}\\.(pack|idx|rev|bitmap|keep)$').test(
                name,
              )
            : relative === 'info'
              ? ['packs', 'commit-graph'].includes(name)
              : /^[a-f0-9]{2}$/.test(relative) &&
                new RegExp('^[a-f0-9]{' + (oidLength - 2) + '}$').test(name);
        if (!valid || !stat.isFile() || stat.nlink !== 1n) return unsupportedGitStorage();
        stored += Number(stat.size);
        profileBackupSession.getStore()?.budget.charge('git-storage:' + canonical, {
          stored,
          entries: count,
          metadata,
        });
        // Linux O_PATH pins metadata without opening the object body for reading.
        const file = fs.openSync(
          join(assetFdPath(directory), name),
          0x200000 | fs.constants.O_NOFOLLOW,
        );
        try {
          if (
            codingAssetMount(file) !== mount ||
            codingAssetIdentity(stat) !== codingAssetIdentity(fs.fstatSync(file, { bigint: true }))
          )
            return unsupportedGitStorage();
          checkAssetPath(file, join(canonical, path));
        } finally {
          fs.closeSync(file);
        }
      }
    }
    if (before !== codingAssetIdentity(fs.fstatSync(directory, { bigint: true })))
      throw Error('stale_coding_git_storage');
    checkAssetPath(directory, join(canonical, relative));
    states.push([relative, before]);
  };
  walk(fd, '');
  return createHash('sha256').update(JSON.stringify(states)).digest('hex');
}
export function readGitDescriptor(file: number, maxBytes: number): Buffer {
  checkProfileArchiveFile(file);
  const before = fs.fstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes) ||
    before.uid !== BigInt(process.getuid?.() ?? -1)
  )
    return unsupportedGitStorage();
  const buffer = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(file, buffer, offset, buffer.length - offset, offset);
    if (!count) throw Error('stale_coding_git_storage');
    offset += count;
  }
  if (codingAssetIdentity(before) !== codingAssetIdentity(fs.fstatSync(file, { bigint: true })))
    throw Error('stale_coding_git_storage');
  return buffer;
}
export function readGitFile(parent: number, name: string, maxBytes: number): Buffer {
  const file = fs.openSync(
    join(assetFdPath(parent), name),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = codingAssetIdentity(fs.fstatSync(file, { bigint: true }));
    const body = readGitDescriptor(file, maxBytes);
    if (
      before !==
      codingAssetIdentity(fs.lstatSync(join(assetFdPath(parent), name), { bigint: true }))
    )
      throw Error('stale_coding_git_storage');
    return body;
  } finally {
    fs.closeSync(file);
  }
}
export function readGitBranch(common: number, canonical: string, branch: string): string {
  let parent = common;
  try {
    const parts = ('refs/heads/' + branch).split('/');
    for (const [index, part] of parts.slice(0, -1).entries()) {
      const next = fs.openSync(join(assetFdPath(parent), part), assetDirectoryFlags);
      if (parent !== common) fs.closeSync(parent);
      parent = next;
      checkAssetPath(parent, join(canonical, ...parts.slice(0, index + 1)));
    }
    const ref = readGitFile(parent, parts.at(-1)!, 128).toString('utf8');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n?$/.test(ref)) return unsupportedGitStorage();
    return ref.replace(/\n$/, '');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const packed = readGitFile(common, 'packed-refs', 16777216).toString('utf8').split('\n');
    const rows = packed.filter((line) => line.endsWith(' refs/heads/' + branch));
    if (rows.length !== 1) return unsupportedGitStorage();
    return rows[0]!.split(' ')[0]!;
  } finally {
    if (parent !== common) fs.closeSync(parent);
  }
}
