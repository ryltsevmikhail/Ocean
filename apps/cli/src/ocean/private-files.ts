import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
/** Private local files only; symlinked ancestors are not accepted for a profile. */
export function privatePath(path: string, directory: boolean): boolean {
  try {
    const s = lstatSync(path);
    return (
      !s.isSymbolicLink() &&
      (directory ? s.isDirectory() : s.isFile() && s.nlink === 1) &&
      s.uid === process.getuid?.() &&
      (s.mode & 0o077) === 0 &&
      realpathSync(path) === resolve(path)
    );
  } catch {
    return false;
  }
}
export function assertPrivate(path: string, directory: boolean): void {
  if (!privatePath(path, directory)) throw new Error('insecure_permissions');
}
export function absolutePath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('invalid_input');
  return path;
}
export function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function assertProfileFiles(directory: string): void {
  assertPrivate(directory, true);
  for (const name of ['runtime.sqlite', 'runtime.sqlite-wal', 'runtime.sqlite-shm']) {
    const path = directory + '/' + name;
    if (existsSync(path)) assertPrivate(path, false);
  }
}

export function atomicPrivateJson(path: string, value: unknown): void {
  const temp = join(dirname(path), '.metadata-' + randomUUID());
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    syncFile(temp);
    renameSync(temp, path);
    syncFile(dirname(path));
  } finally {
    rmSync(temp, { force: true });
  }
}
