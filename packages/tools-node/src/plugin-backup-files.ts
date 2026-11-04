/**
 * Backup assets for the shipped plugin catalog.
 *
 * Only verified declarative manifest bytes are archived; connection and grant
 * metadata live in the SQLite snapshot and credential references never leave the
 * database as values. A profile that records an installed version whose private
 * manifest file is missing or does not hash to the pinned digest makes the whole
 * backup refuse explicitly instead of silently dropping authoritative data.
 */

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import {
  validPluginBackupInventory,
  type PluginBackupInventory,
  type PluginBackupVersion,
} from '@runnets/domain';

export interface PluginBackupFile {
  readonly pluginId: string;
  readonly version: string;
  /** SHA-256 of the archived manifest bytes; equal to the pinned manifest digest. */
  readonly sha256: string;
  readonly bytes: number;
}

export interface PluginBackupAssetCatalog {
  readonly format: 1;
  readonly inventoryHash: string;
  readonly files: readonly PluginBackupFile[];
  readonly hash: string;
}

export function pluginBackupHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;
const PLUGIN_DIR_FLAGS =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;
const FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function validVersion(entry: PluginBackupVersion): boolean {
  return (
    ID.test(entry.pluginId) && VERSION.test(entry.version) && DIGEST.test(entry.manifestDigest)
  );
}

function validArchivedFile(file: PluginBackupFile): boolean {
  return ID.test(file.pluginId) && VERSION.test(file.version) && DIGEST.test(file.sha256);
}

/** Version directory under the profile; both segments are validated identifiers. */
export function pluginVersionDirectory(profile: string, pluginId: string, version: string): string {
  if (!ID.test(pluginId) || !VERSION.test(version)) throw Error('invalid_plugin_inventory');
  return join(profile, 'plugins', pluginId, version);
}

function readVerifiedManifest(
  profile: string,
  entry: PluginBackupVersion,
): { readonly bytes: Buffer; readonly sha256: string } {
  const directory = pluginVersionDirectory(profile, entry.pluginId, entry.version);
  const path = join(directory, 'manifest.json');
  let fd: number | undefined;
  try {
    const dirFd = fs.openSync(directory, PLUGIN_DIR_FLAGS);
    fs.closeSync(dirFd);
    fd = fs.openSync(path, FILE_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 65536)
      throw Error('plugin_assets_unavailable');
    if ((stat.mode & 0o777) !== 0o600) throw Error('plugin_assets_insecure');
    const bytes = fs.readFileSync(fd);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.manifestDigest) throw Error('plugin_assets_unavailable');
    return { bytes, sha256 };
  } catch (error) {
    if (error instanceof Error && error.message === 'plugin_assets_insecure') throw error;
    throw Error('plugin_assets_unavailable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Archive every verified installed manifest; requires a complete inventory. */
export function archivePluginBackupFiles(
  inventory: PluginBackupInventory,
  profile: string,
  destination: string,
): PluginBackupAssetCatalog {
  if (!validPluginBackupInventory(inventory)) throw Error('invalid_plugin_inventory');
  if (destination.length === 0) throw Error('invalid_plugin_inventory');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const files: PluginBackupFile[] = [];
  for (const entry of inventory.versions) {
    if (!validVersion(entry)) throw Error('invalid_plugin_inventory');
    if (entry.state !== 'installed') continue;
    const verified = readVerifiedManifest(profile, entry);
    const directory = join(destination, entry.pluginId, entry.version);
    fs.mkdirSync(join(destination, entry.pluginId), { recursive: false, mode: 0o700 });
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    const output = join(directory, 'manifest.json');
    fs.writeFileSync(output, verified.bytes, { mode: 0o600, flag: 'wx' });
    const written = fs.readFileSync(output);
    if (createHash('sha256').update(written).digest('hex') !== entry.manifestDigest)
      throw Error('stale_coding_asset');
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    files.push({
      pluginId: entry.pluginId,
      version: entry.version,
      sha256: entry.manifestDigest,
      bytes: verified.bytes.length,
    });
  }
  const body = { format: 1 as const, inventoryHash: inventory.hash, files };
  return { ...body, hash: pluginBackupHash(body) };
}

/** Verify the archive without following any path recorded in its catalog. */
export function verifyPluginBackupFiles(
  directory: string,
  expected: PluginBackupAssetCatalog,
): void {
  if (expected.format !== 1 || expected.inventoryHash.length === 0) throw Error('invalid_backup');
  const { hash, ...body } = expected;
  if (pluginBackupHash(body) !== hash) throw Error('invalid_backup');
  const seen = new Set<string>();
  for (const file of expected.files) {
    if (!validArchivedFile(file)) throw Error('invalid_backup');
    const key = file.pluginId + '@' + file.version;
    if (seen.has(key)) throw Error('invalid_backup');
    seen.add(key);
    const path = join(directory, file.pluginId, file.version, 'manifest.json');
    let fd: number | undefined;
    try {
      fd = fs.openSync(path, FILE_FLAGS);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== file.bytes) throw Error('invalid_backup');
      const bytes = fs.readFileSync(fd);
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        throw Error('invalid_backup');
    } catch {
      throw Error('invalid_backup');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  const entries: string[] = [];
  const walk = (path: string) => {
    for (const name of fs.readdirSync(path).sort()) {
      const child = join(path, name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw Error('invalid_backup');
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) entries.push(relative(directory, child));
      else throw Error('invalid_backup');
    }
  };
  walk(directory);
  const expectedPaths = expected.files
    .map((file) => join(file.pluginId, file.version, 'manifest.json'))
    .sort();
  if (entries.sort().join('\n') !== expectedPaths.join('\n')) throw Error('invalid_backup');
}

/** Restore the verified archive into the new profile only; no execution occurs. */
export function restorePluginBackupFiles(source: string, profile: string): void {
  const root = join(profile, 'plugins');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const pluginId of fs.readdirSync(source).sort()) {
    if (!ID.test(pluginId)) throw Error('invalid_backup');
    fs.mkdirSync(join(root, pluginId), { mode: 0o700 });
    for (const version of fs.readdirSync(join(source, pluginId)).sort()) {
      if (!VERSION.test(version)) throw Error('invalid_backup');
      const directory = join(root, pluginId, version);
      fs.mkdirSync(directory, { mode: 0o700 });
      const bytes = fs.readFileSync(join(source, pluginId, version, 'manifest.json'));
      if (bytes.length === 0 || bytes.length > 65536) throw Error('invalid_backup');
      fs.writeFileSync(join(directory, 'manifest.json'), bytes, { mode: 0o600, flag: 'wx' });
    }
  }
}
