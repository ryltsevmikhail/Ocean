import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import type { CodingFileChange, CodingFileContent } from '@runnets/domain';
import { codingPath } from './coding-git.js';
import { blockedName } from './backend.js';
import type { CodingApplyRecovery } from './coding-apply-scope.js';
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const fdPath = (fd: number) => '/proc/self/fd/' + String(fd);
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
function valid(content: CodingFileContent | null): void {
  if (content === null) return;
  if (
    !['100644', '100755'].includes(content.mode) ||
    Buffer.byteLength(content.text) > 131072 ||
    content.text.includes('\0') ||
    hash(content.text) !== content.sha256 ||
    Buffer.from(content.text).toString('utf8') !== content.text
  )
    throw Error('invalid apply content');
}
function rootDirectory(root: string, privateDirectory = false): number {
  if (fs.realpathSync(root) !== root) throw Error('noncanonical apply directory');
  const fd = fs.openSync(root, directoryFlags);
  const stat = fs.fstatSync(fd);
  if (privateDirectory && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
    fs.closeSync(fd);
    throw Error('private recovery directory required');
  }
  return fd;
}
function parentDirectory(root: number, relative: string, create: boolean): number {
  let fd = fs.openSync(fdPath(root), directoryFlags & ~fs.constants.O_NOFOLLOW);
  try {
    for (const part of relative.split('/').filter((p) => p !== '.')) {
      const path = join(fdPath(fd), part);
      if (create) {
        try {
          fs.mkdirSync(path, { mode: 0o755 });
          fs.fsyncSync(fd);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
      const next = fs.openSync(path, directoryFlags);
      fs.closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function sameDirectory(root: number, relative: string, parent: number): void {
  const current = parentDirectory(root, relative, false);
  try {
    const a = fs.fstatSync(current),
      b = fs.fstatSync(parent);
    if (a.dev !== b.dev || a.ino !== b.ino) throw Error('apply parent changed');
  } finally {
    fs.closeSync(current);
  }
}
function read(path: string, synchronize = false): CodingFileContent | null {
  let fd: number;
  try {
    fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 131072)
      throw Error('unsupported apply file');
    const buffer = Buffer.alloc(131073);
    let length = 0,
      count: number;
    while (
      length < buffer.length &&
      (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0
    )
      length += count;
    if (synchronize) fs.fsyncSync(fd);
    const body = buffer.subarray(0, length),
      after = fs.fstatSync(fd);
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      after.nlink !== 1
    )
      throw Error('apply file changed');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    if (text.includes('\0')) throw Error('unsupported apply file');
    return { text, mode: before.mode & 0o111 ? '100755' : '100644', sha256: hash(body) };
  } finally {
    fs.closeSync(fd);
  }
}
function matches(path: string, expected: CodingFileContent | null, synchronize = false): void {
  const actual = read(path, synchronize);
  if (
    actual === null
      ? expected !== null
      : expected === null ||
        actual.mode !== expected.mode ||
        actual.text !== expected.text ||
        actual.sha256 !== expected.sha256
  )
    throw Error('apply preimage changed');
}
function removeEmptyTree(parent: number, name: string, budget = { remaining: 1000 }): void {
  if (--budget.remaining < 0) throw Error('apply directory limit');
  const path = join(fdPath(parent), name);
  const directory = fs.openSync(path, directoryFlags);
  try {
    const pinned = fs.fstatSync(directory);
    const entries = fs.readdirSync(fdPath(directory), { withFileTypes: true });
    if (
      entries.length > budget.remaining ||
      entries.some((entry) => !entry.isDirectory() || blockedName(entry.name))
    )
      throw Error('apply directory not empty');
    for (const entry of entries) removeEmptyTree(directory, entry.name, budget);
    const current = fs.lstatSync(path);
    if (current.dev !== pinned.dev || current.ino !== pinned.ino)
      throw Error('apply directory changed');
    fs.rmdirSync(path);
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(directory);
  }
}
/** Called only after a durable per-file started receipt. Never removes recovery assets. */
export function applyCodingFile(
  root: string,
  recoveryDirectory: string | CodingApplyRecovery,
  change: CodingFileChange,
): void {
  codingPath(change.path);
  if (change.path.split('/').some(blockedName) || (!change.before && !change.after))
    throw Error('unsupported apply path');
  valid(change.before);
  valid(change.after);
  const project = rootDirectory(root);
  let recovery: number | undefined, parent: number | undefined;
  const checkRecovery = () => {
    if (typeof recoveryDirectory !== 'string') recoveryDirectory.check();
  };
  try {
    checkRecovery();
    recovery =
      typeof recoveryDirectory === 'string'
        ? rootDirectory(recoveryDirectory, true)
        : recoveryDirectory.fd;
    if (fs.fstatSync(project).dev !== fs.fstatSync(recovery).dev)
      throw Error('cross-device recovery unsupported');
    const id = randomUUID(),
      prefix = join(fdPath(recovery), id);
    const record = prefix + '.json',
      backup = prefix + '.before',
      staged = prefix + '.after';
    const intent = {
      version: 1,
      root,
      path: change.path,
      before: change.before,
      after: change.after,
      backup: id + '.before',
      staged: id + '.after',
    };
    const save = (status: string, exclusive: boolean) => {
      checkRecovery();
      const target = exclusive ? record : record + '.next';
      const file = fs.openSync(target, 'wx', 0o600);
      try {
        fs.writeFileSync(file, JSON.stringify({ ...intent, status }));
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      if (!exclusive) fs.renameSync(target, record);
      fs.fsyncSync(recovery!);
    };
    save('started', true);
    if (change.after) {
      const file = fs.openSync(staged, 'wx', 0o600);
      try {
        fs.writeFileSync(file, change.after.text);
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      fs.fsyncSync(recovery);
    }
    checkRecovery();
    const relative = dirname(change.path);
    parent = parentDirectory(project, relative, change.before === null);
    const destination = join(fdPath(parent), basename(change.path));
    if (!change.before) {
      // Empty directories can remain after an approved file→directory refactor.
      try {
        if (fs.lstatSync(destination).isDirectory()) {
          removeEmptyTree(parent, basename(change.path));
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    matches(destination, change.before);
    if (change.after) {
      const access = change.before ? fs.lstatSync(destination).mode & 0o666 : 0o600;
      const mode = access | (change.after.mode === '100755' ? (access & 0o444) >> 2 : 0);
      const file = fs.openSync(staged, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        fs.fchmodSync(file, mode);
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
    }
    sameDirectory(project, relative, parent);
    checkRecovery();
    if (change.before) {
      fs.renameSync(destination, backup);
      fs.fsyncSync(parent);
      fs.fsyncSync(recovery);
      checkRecovery();
      matches(backup, change.before, true);
      sameDirectory(project, relative, parent);
    }
    if (change.after) {
      checkRecovery();
      fs.linkSync(staged, destination);
      fs.fsyncSync(parent);
      fs.unlinkSync(staged);
      fs.fsyncSync(recovery);
      checkRecovery();
    }
    sameDirectory(project, relative, parent);
    if (fs.realpathSync(root) !== root) throw Error('apply root changed');
    const rootStat = fs.statSync(root),
      pinned = fs.fstatSync(project);
    if (rootStat.dev !== pinned.dev || rootStat.ino !== pinned.ino)
      throw Error('apply root changed');
    save('completed', false);
  } finally {
    if (parent !== undefined) fs.closeSync(parent);
    if (recovery !== undefined && typeof recoveryDirectory === 'string') fs.closeSync(recovery);
    fs.closeSync(project);
  }
}
