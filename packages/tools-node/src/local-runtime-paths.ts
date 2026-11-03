import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { localRuntimeRecord, type LocalRuntimeDescriptor } from '@runnets/contracts';
import { workerVisibleSystemPath } from './worker-system-paths.js';
export interface LocalRuntimePaths {
  readonly profile: string;
  readonly profileId: string;
  readonly root: string;
  readonly directory: string;
  readonly descriptor: string;
  readonly endpoint: string;
}
function fail(code: string): never {
  throw Error(code);
}
export function assertLocalPrivate(path: string, kind: 'directory' | 'file' | 'socket'): Stats {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    realpathSync(path) !== resolve(path) ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o7777) !== (kind === 'directory' ? 0o700 : 0o600) ||
    !(kind === 'directory'
      ? s.isDirectory()
      : kind === 'file'
        ? s.isFile() && s.nlink === 1
        : s.isSocket() && s.nlink === 1)
  )
    fail('insecure_permissions');
  assertTrustedAncestors(path);
  return s;
}
/** Other UIDs must not be able to replace a validated private subtree by renaming its parent. */
function assertTrustedAncestors(path: string): void {
  let parent = dirname(path);
  while (true) {
    const s = lstatSync(parent);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      (s.uid !== 0 && s.uid !== process.getuid?.()) ||
      ((s.mode & 0o022) !== 0 && (s.mode & 0o1000) === 0)
    )
      fail('insecure_permissions');
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}
export function localRuntimePaths(profile: string): LocalRuntimePaths {
  return checkedPaths(profile, false);
}
function checkedPaths(profile: string, allowMissing: boolean): LocalRuntimePaths {
  if (!isAbsolute(profile) || profile !== resolve(profile)) fail('insecure_permissions');
  if (allowMissing && !entryExists(profile)) {
    let existing = dirname(profile);
    while (!entryExists(existing)) existing = dirname(existing);
    if (realpathSync(existing) !== existing || !lstatSync(existing).isDirectory())
      fail('insecure_permissions');
    assertTrustedAncestors(join(existing, 'prospective-profile'));
  } else assertLocalPrivate(profile, 'directory');
  const profileId = createHash('sha256').update(profile).digest('hex');
  const fallback = '/tmp/ocean-' + process.getuid?.();
  let root = process.env['XDG_RUNTIME_DIR'] ?? fallback;
  if (!isAbsolute(root) || resolve(root) !== root) fail('insecure_permissions');
  assertTrustedAncestors(root);
  if (existsSync(root)) assertLocalPrivate(root, 'directory');
  // Linux sockaddr_un reserves one byte for NUL. Use a short private fallback.
  if (Buffer.byteLength(join(root, 'ocean-' + profileId.slice(0, 24), 'runtime.sock')) > 103) {
    root = fallback;
    if (existsSync(root)) assertLocalPrivate(root, 'directory');
  }
  const directory = join(root, 'ocean-' + profileId.slice(0, 24));
  if (workerVisibleSystemPath(directory)) fail('worker_visible_endpoint');
  const endpoint = join(directory, 'runtime.sock');
  if (Buffer.byteLength(endpoint) > 103) fail('endpoint_path_too_long');
  return {
    profile,
    profileId,
    root,
    directory,
    endpoint,
    descriptor: join(directory, 'connection.json'),
  };
}
export function prepareLocalRuntimeDirectory(paths: LocalRuntimePaths): void {
  for (const path of [paths.root, paths.directory]) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    assertLocalPrivate(path, 'directory');
  }
}
export function prepareLocalRuntimePaths(paths: LocalRuntimePaths): void {
  prepareLocalRuntimeDirectory(paths);
  for (const path of [paths.descriptor, paths.endpoint]) {
    try {
      lstatSync(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    fail('endpoint_exists');
  }
}
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
export function readLocalRuntimeDescriptor(
  profile: string,
  allowMissingProfile = false,
): LocalRuntimeDescriptor {
  const p = checkedPaths(profile, allowMissingProfile);
  for (const path of [p.root, p.directory]) {
    if (!entryExists(path)) fail('runtime_absent');
    assertLocalPrivate(path, 'directory');
  }
  if (!entryExists(p.descriptor)) {
    const dir = opendirSync(p.directory);
    try {
      fail(dir.readSync() ? 'endpoint_exists' : 'runtime_absent');
    } finally {
      dir.closeSync();
    }
  }
  if (!entryExists(profile)) fail('profile_missing');
  assertLocalPrivate(profile, 'directory');
  const before = assertLocalPrivate(p.descriptor, 'file');
  const fd = openSync(
    p.descriptor,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let value: unknown;
  try {
    const pinned = fstatSync(fd);
    if (
      !pinned.isFile() ||
      pinned.nlink !== 1 ||
      pinned.uid !== before.uid ||
      pinned.mode !== before.mode ||
      pinned.ino !== before.ino ||
      pinned.dev !== before.dev ||
      pinned.size > 4096
    )
      fail('insecure_permissions');
    const bytes = Buffer.alloc(4097);
    try {
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      if (length !== pinned.size) fail('invalid_descriptor');
      value = JSON.parse(bytes.toString('utf8', 0, length)) as unknown;
    } catch {
      fail('invalid_descriptor');
    } finally {
      bytes.fill(0);
    }
  } finally {
    closeSync(fd);
  }
  if (
    !localRuntimeRecord(value) ||
    value['protocol'] !== 1 ||
    value['profileId'] !== p.profileId ||
    typeof value['instanceId'] !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value['instanceId']) ||
    value['endpoint'] !== p.endpoint ||
    typeof value['capability'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['capability'])
  )
    fail('invalid_descriptor');
  if (!entryExists(p.endpoint)) fail('runtime_unreachable');
  assertLocalPrivate(p.endpoint, 'socket');
  return value as unknown as LocalRuntimeDescriptor;
}
export function ownsLocalRuntimePath(path: string, owned: Stats): boolean {
  try {
    const current = lstatSync(path);
    return (
      !current.isSymbolicLink() &&
      current.ino === owned.ino &&
      current.dev === owned.dev &&
      current.uid === owned.uid &&
      current.mode === owned.mode
    );
  } catch {
    return false;
  }
}
export function unlinkOwnedLocalRuntimePath(path: string, owned: Stats): void {
  if (ownsLocalRuntimePath(path, owned)) unlinkSync(path);
}
