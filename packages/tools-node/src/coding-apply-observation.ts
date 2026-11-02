import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { CodingApplyFileObservation } from '@runnets/domain';
import { codingPath } from './coding-git.js';
import { blockedName } from './backend.js';
const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const fdPath = (fd: number) => '/proc/self/fd/' + String(fd);
const absent = (
  path: string,
  kind: 'missing' | 'directory' | 'unavailable',
): CodingApplyFileObservation => ({ path, kind, sha256: null, mode: null });
function observe(
  root: string,
  rootFd: number,
  path: string,
  budget: { bytes: number },
): CodingApplyFileObservation {
  let parent = rootFd;
  try {
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      const nextPath = join(fdPath(parent), part);
      let entry: fs.Stats;
      try {
        entry = fs.lstatSync(nextPath);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return absent(path, 'missing');
        throw error;
      }
      if (entry.isSymbolicLink()) return absent(path, 'unavailable');
      if (!entry.isDirectory())
        return absent(path, entry.isFile() && entry.nlink === 1 ? 'missing' : 'unavailable');
      const next = fs.openSync(nextPath, flags);
      if (parent !== rootFd) fs.closeSync(parent);
      parent = next;
    }
    const parentPath = join(root, dirname(path));
    if (fs.realpathSync(fdPath(parent)) !== parentPath) return absent(path, 'unavailable');
    const target = join(fdPath(parent), parts.at(-1)!);
    let entry: fs.BigIntStats;
    try {
      entry = fs.lstatSync(target, { bigint: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return absent(path, 'missing');
      throw error;
    }
    if (entry.isDirectory()) return absent(path, 'directory');
    if (!entry.isFile() || entry.nlink !== 1n) return absent(path, 'unavailable');
    const file = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const before = fs.fstatSync(file, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.ino !== entry.ino ||
        before.dev !== entry.dev ||
        before.size > 131072n ||
        before.size > BigInt(budget.bytes)
      )
        return absent(path, 'unavailable');
      const body = Buffer.alloc(Number(before.size) + 1);
      let length = 0,
        count: number;
      while (
        length < body.length &&
        (count = fs.readSync(file, body, length, body.length - length, null)) > 0
      )
        length += count;
      budget.bytes -= length;
      const after = fs.fstatSync(file, { bigint: true }),
        current = fs.lstatSync(target, { bigint: true });
      if (
        BigInt(length) !== before.size ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.mode !== after.mode ||
        after.nlink !== 1n ||
        current.ino !== after.ino ||
        current.dev !== after.dev ||
        fs.realpathSync(fdPath(parent)) !== parentPath
      )
        return absent(path, 'unavailable');
      return {
        path,
        kind: 'file',
        mode: before.mode & 0o111n ? '100755' : '100644',
        sha256: createHash('sha256').update(body.subarray(0, length)).digest('hex'),
      };
    } finally {
      fs.closeSync(file);
    }
  } catch {
    return absent(path, 'unavailable');
  } finally {
    if (parent !== rootFd) fs.closeSync(parent);
  }
}
/** Read-only Linux FD inspection. Hashes never confer execution or settlement authority. */
export function observeCodingFiles(
  root: string,
  paths: readonly string[],
): readonly CodingApplyFileObservation[] {
  if (paths.length > 1000 || new Set(paths).size !== paths.length)
    throw Error('observation path limit');
  for (const path of paths) {
    codingPath(path);
    if (path.split('/').some(blockedName)) throw Error('protected observation path');
  }
  if (fs.realpathSync(root) !== root) throw Error('canonical project root required');
  const directory = fs.openSync(root, flags);
  try {
    const pinned = fs.fstatSync(directory, { bigint: true }),
      budget = { bytes: 33554432 };
    const observed = paths.map((path) => observe(root, directory, path, budget));
    const current = fs.lstatSync(root, { bigint: true });
    if (
      current.ino !== pinned.ino ||
      current.dev !== pinned.dev ||
      !current.isDirectory() ||
      fs.realpathSync(root) !== root
    )
      return paths.map((path) => absent(path, 'unavailable'));
    return observed;
  } finally {
    fs.closeSync(directory);
  }
}
