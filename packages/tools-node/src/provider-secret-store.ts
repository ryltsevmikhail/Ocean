/**
 * Private provider credential store.
 *
 * Credential bytes live only here: a directory outside the profile and its
 * backup, mode 0700, holding one JSON file of opaque references at mode 0600.
 * Publication is atomic (exclusive temp file, fsync file and directory, rename).
 * A left-over temp file is inert; a malformed or over-permissive file reads as
 * an explicit `unverified` state instead of a silent fallback.
 */

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProviderSecretRead, ProviderSecretStorePort } from '@runnets/application';

export const PROVIDER_SECRET_FILE = 'providers.json';
/** Sibling directory name derived deterministically from the profile path. */
export const PROVIDER_CREDENTIAL_SUFFIX = '.credentials';
const FORMAT_VERSION = 1;
const MAX_KEY_LENGTH = 512;
const MAX_FILE_BYTES = 64 * 1024;
const REF_PATTERN = /^psec_[a-z0-9]{8,64}$/;
const TEMP_PREFIX = '.providers-';

/** `<profileParent>/<profileName>.credentials/` — never inside the profile or its backup. */
export function providerCredentialDirectory(profile: string): string {
  if (!isAbsolute(profile) || resolve(profile) !== profile) throw Error('invalid_input');
  return join(dirname(profile), basename(profile) + PROVIDER_CREDENTIAL_SUFFIX);
}

type DirectoryState = 'absent' | 'ok' | 'insecure';
type FileState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'insecure' }
  | { readonly kind: 'ok'; readonly text: string };

function ownedPrivate(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}
function inspectDirectory(directory: string): DirectoryState {
  try {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      !ownedPrivate(stat.mode, 0o700) ||
      realpathSync(directory) !== resolve(directory)
    )
      return 'insecure';
    return 'ok';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'insecure';
  }
}
function inspectFile(path: string): FileState {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'insecure' };
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    !ownedPrivate(stat.mode, 0o600) ||
    stat.size > MAX_FILE_BYTES
  )
    return { kind: 'insecure' };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const pinned = fstatSync(fd);
    if (pinned.dev !== stat.dev || pinned.ino !== stat.ino || pinned.size !== stat.size)
      return { kind: 'insecure' };
    return { kind: 'ok', text: readFileSync(fd, 'utf8') };
  } catch {
    return { kind: 'insecure' };
  } finally {
    closeSync(fd);
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_PATTERN.test(ref);
}
function validKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    key.trim() !== '' &&
    !key.includes('\0')
  );
}
/** Parse the private format; null means the file cannot be trusted. */
function parseSecrets(text: string): Map<string, string> | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!record(value) || value['version'] !== FORMAT_VERSION || !record(value['secrets']))
    return null;
  const secrets = new Map<string, string>();
  for (const [ref, entry] of Object.entries(value['secrets'])) {
    if (!validRef(ref) || !record(entry) || !validKey(entry['key'])) return null;
    secrets.set(ref, entry['key']);
  }
  return secrets;
}
function serialize(secrets: ReadonlyMap<string, string>): string {
  const body: Record<string, { key: string }> = {};
  for (const [ref, key] of secrets) body[ref] = { key };
  return JSON.stringify({ version: FORMAT_VERSION, secrets: body }) + '\n';
}
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function ensureDirectory(directory: string): void {
  const state = inspectDirectory(directory);
  if (state === 'insecure') throw Error('insecure_permissions');
  if (state === 'ok') return;
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw Error('provider_write_failed');
  }
  if (inspectDirectory(directory) !== 'ok') throw Error('insecure_permissions');
}
function publish(directory: string, text: string): void {
  ensureDirectory(directory);
  const target = join(directory, PROVIDER_SECRET_FILE);
  const temp = join(directory, TEMP_PREFIX + randomBytes(12).toString('hex') + '.tmp');
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    syncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    throw Error(
      code === 'EACCES' || code === 'EPERM' ? 'insecure_permissions' : 'provider_write_failed',
    );
  }
}
/**
 * Open the private store. Directory creation and publication happen only for an
 * explicit owner write; reads tolerate an absent store and never create files.
 */
export function createProviderSecretStore(directory: string): ProviderSecretStorePort {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw Error('invalid_input');
  return {
    read(ref: string): ProviderSecretRead {
      if (!validRef(ref)) return { status: 'unverified', reason: 'provider_secret_corrupt' };
      const state = inspectDirectory(directory);
      if (state === 'absent') return { status: 'absent' };
      if (state === 'insecure') return { status: 'unverified', reason: 'provider_secret_insecure' };
      const file = inspectFile(join(directory, PROVIDER_SECRET_FILE));
      if (file.kind === 'absent') return { status: 'absent' };
      if (file.kind === 'insecure')
        return { status: 'unverified', reason: 'provider_secret_insecure' };
      const secrets = parseSecrets(file.text);
      if (secrets === null) return { status: 'unverified', reason: 'provider_secret_corrupt' };
      const key = secrets.get(ref);
      return key === undefined ? { status: 'absent' } : { status: 'ok', key };
    },
    write(ref: string, key: string): void {
      if (!validRef(ref) || !validKey(key)) throw Error('invalid_input');
      ensureDirectory(directory);
      const file = inspectFile(join(directory, PROVIDER_SECRET_FILE));
      // An unreadable private file cannot be preserved; an explicit owner write replaces it.
      const current = file.kind === 'ok' ? parseSecrets(file.text) : null;
      const secrets = current ?? new Map<string, string>();
      secrets.set(ref, key);
      publish(directory, serialize(secrets));
    },
    remove(ref: string): void {
      if (!validRef(ref)) throw Error('invalid_input');
      if (inspectDirectory(directory) === 'absent') return;
      const file = inspectFile(join(directory, PROVIDER_SECRET_FILE));
      if (file.kind === 'absent') return;
      if (file.kind === 'insecure') throw Error('insecure_permissions');
      const secrets = parseSecrets(file.text);
      // Explicit removal of Ocean-managed values also clears an unreadable file.
      const next = secrets ?? new Map<string, string>();
      next.delete(ref);
      publish(directory, serialize(next));
    },
  };
}
