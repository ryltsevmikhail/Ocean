import { checkProfileArchiveFile } from './profile-archive-context.js';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProfileBackupAssetIdentity } from '@runnets/domain';
import type { CodingAssetCapture } from './coding-asset-state.js';
import { codingAssetIdentity, codingAssetMount } from './coding-asset-state.js';
import { assetDirectoryFlags, checkAssetPath } from './coding-asset-io.js';
import { ProfileBackupOutput } from './profile-backup-output.js';
import { verifyProfileAssetArchive, withProfileArchive } from './profile-backup-verify.js';
import { restoreCodingDependencyTask } from './coding-dependency-archive.js';
import { restoreCodingAssetTree } from './coding-asset-restore.js';
import { restoreDesktopAssets } from './desktop-assets.js';
/** Exact inert archive evidence copy, checked against the first private metadata and byte observation. */
export function copyEvidence(source: CodingAssetCapture, destination: string): ProfileBackupOutput {
  const output = new ProfileBackupOutput(destination),
    states = new Map(source.sourceEntries),
    buffer = Buffer.alloc(1048576);
  const directories = new Map<string, { fd: number; identity: string }>();
  const identity = (fd: number) => {
    const s = fs.fstatSync(fd, { bigint: true });
    return [s.dev, s.ino, s.mode, s.uid, s.gid, codingAssetMount(fd)].join(':');
  };
  const checkDirectories = () => {
    output.check();
    for (const [path, held] of directories) {
      checkAssetPath(held.fd, path);
      const current = fs.openSync(path, assetDirectoryFlags);
      try {
        if (identity(current) !== held.identity) throw Error('stale_coding_asset');
      } finally {
        fs.closeSync(current);
      }
    }
  };
  try {
    for (const entry of source.manifest.entries.slice(1)) {
      checkDirectories();
      const path = join(destination, entry.path);
      if (entry.kind === 'directory') {
        fs.mkdirSync(path, { mode: 0o700 });
        const fd = fs.openSync(path, assetDirectoryFlags);
        directories.set(path, { fd, identity: identity(fd) });
        continue;
      }
      if (entry.kind !== 'file') throw Error('invalid_profile_backup');
      const input = fs.openSync(
        join(source.root, entry.path),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      let target: number | undefined;
      try {
        const check = () => {
          checkAssetPath(input, join(source.root, entry.path));
          if (
            codingAssetIdentity(fs.fstatSync(input, { bigint: true })) !== states.get(entry.path) ||
            codingAssetMount(input) !== source.sourceMount
          )
            throw Error('stale_coding_asset');
        };
        check();
        checkProfileArchiveFile(input);
        checkDirectories();
        const parent =
          dirname(path) === destination ? output.fd : directories.get(dirname(path))!.fd;
        target = fs.openSync(
          join('/proc/self/fd/' + parent, entry.path.split('/').at(-1)!),
          'wx',
          0o600,
        );
        const digest = createHash('sha256');
        let offset = 0;
        while (offset < entry.bytes) {
          const n = fs.readSync(
            input,
            buffer,
            0,
            Math.min(buffer.length, entry.bytes - offset),
            offset,
          );
          if (!n) throw Error('stale_coding_asset');
          digest.update(buffer.subarray(0, n));
          let written = 0;
          while (written < n) {
            const amount = fs.writeSync(target, buffer, written, n - written);
            if (!amount) throw Error('profile_backup_write_failed');
            written += amount;
          }
          offset += n;
        }
        check();
        if (digest.digest('hex') !== entry.sha256) throw Error('stale_coding_asset');
        fs.fsyncSync(target);
        checkDirectories();
      } finally {
        fs.closeSync(input);
        if (target !== undefined) fs.closeSync(target);
      }
    }
    for (const entry of [...source.manifest.entries].reverse()) {
      if (entry.kind !== 'directory') continue;
      const fd = fs.openSync(join(destination, entry.path), assetDirectoryFlags);
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    checkDirectories();
    return output;
  } catch (error) {
    output.close();
    throw error;
  } finally {
    for (const { fd } of directories.values()) fs.closeSync(fd);
  }
}
/** Full inert quarantine: evidence plus virtual dependency/task trees, recovery and Desktop bytes. */
export function restoreProfileBackupAssets(
  source: string,
  destination: string,
  expected: ProfileBackupAssetIdentity,
) {
  if (destination === source || destination.startsWith(source + '/'))
    throw Error('invalid_profile_backup_destination');
  let output: ProfileBackupOutput | undefined;
  try {
    const result = verifyProfileAssetArchive(source, expected, false, ({ catalog }) => {
      output = new ProfileBackupOutput(destination);
      let evidence: ProfileBackupOutput | undefined;
      try {
        withProfileArchive(source, (original) => {
          evidence = copyEvidence(original, join(destination, 'evidence'));
        });
        evidence!.publish();
      } finally {
        evidence?.close();
      }
      fs.mkdirSync(join(destination, 'worktrees'), { mode: 0o700 });
      for (const task of catalog.dependencies.tasks) {
        const tree = catalog.worktrees.worktrees.find((w) => w.taskId === task.taskId);
        const slot = tree?.slot ?? createHash('sha256').update(task.taskId).digest('hex');
        restoreCodingDependencyTask(
          join(source, 'dependencies'),
          task.taskId,
          join(destination, 'worktrees', slot),
        );
      }
      fs.mkdirSync(join(destination, 'recovery'), { mode: 0o700 });
      for (const name of fs.readdirSync(join(source, 'recovery')))
        restoreCodingAssetTree(join(source, 'recovery', name), join(destination, 'recovery', name));
      if (catalog.desktop)
        restoreDesktopAssets(join(source, 'desktop'), join(destination, 'desktop'));
      output.write('relationships.json', catalog);
    });
    output!.publish();
    return result;
  } finally {
    output?.close();
  }
}
