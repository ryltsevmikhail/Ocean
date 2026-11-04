/**
 * Private verified copy of one declarative plugin manifest.
 *
 * Layout: `<profile>/plugins/<pluginId>/<version>/manifest.json`, directories
 * 0700 and files 0600. Publication writes a sibling temp directory and renames
 * it into place, so a crash can never expose a half-written version. The store
 * holds only declarative JSON; no executable code is installed and no network
 * request is made.
 */

import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalJson, type PluginManifest } from '@runnets/domain';
import type {
  PluginCredentialReferencePort,
  PluginInstalledFile,
  PluginInstalledFileRead,
  PluginInstallStorePort,
} from '@runnets/application';

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;
const TEMP = /^\.tmp-[a-f0-9]{32}$/;
const DIRECTORY_FLAGS =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;
const FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function assertSegment(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw Error('invalid_plugin_identity');
}

function fsyncDirectory(path: string): void {
  const fd = fs.openSync(path, DIRECTORY_FLAGS);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Canonical bytes published for one manifest; the pinned digest is over exactly these bytes. */
export function pluginManifestBytes(manifest: PluginManifest): Buffer {
  return Buffer.from(canonicalJson(manifest), 'utf8');
}

export interface PluginInstallStore extends PluginInstallStorePort {
  /** Remove only this store's own interrupted temp publications. */
  sweepInterrupted(): number;
}

export function pluginDirectory(profile: string): string {
  return join(profile, 'plugins');
}

export function createPluginInstallStore(options: {
  readonly profile: string;
  readonly nextId?: () => string;
}): PluginInstallStore {
  const root = pluginDirectory(options.profile);
  const random = options.nextId ?? (() => randomUUID().replaceAll('-', ''));
  const versionDirectory = (pluginId: string, version: string) => {
    assertSegment(pluginId, ID);
    assertSegment(version, VERSION);
    return join(root, pluginId, version);
  };
  return {
    sweepInterrupted(): number {
      if (!fs.existsSync(root)) return 0;
      let removed = 0;
      for (const name of fs.readdirSync(root)) {
        if (!TEMP.test(name)) continue;
        const path = join(root, name);
        try {
          if (fs.lstatSync(path).isDirectory()) {
            fs.rmSync(path, { recursive: true, force: true });
            removed++;
          }
        } catch {
          // A racing owner may have removed it already; interrupted copies are inert.
        }
      }
      return removed;
    },
    publish(pluginId: string, version: string, manifest: PluginManifest): PluginInstalledFile {
      assertSegment(pluginId, ID);
      assertSegment(version, VERSION);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const pluginRoot = join(root, pluginId);
      const finalDirectory = versionDirectory(pluginId, version);
      if (fs.existsSync(finalDirectory)) throw Error('install_conflict');
      const temp = join(root, '.tmp-' + random());
      fs.mkdirSync(temp, { mode: 0o700 });
      const bytes = pluginManifestBytes(manifest);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      try {
        fs.writeFileSync(join(temp, 'manifest.json'), bytes, { mode: 0o600, flag: 'wx' });
        const fileFd = fs.openSync(join(temp, 'manifest.json'), FILE_FLAGS);
        try {
          fs.fsyncSync(fileFd);
        } finally {
          fs.closeSync(fileFd);
        }
        fsyncDirectory(temp);
        fs.mkdirSync(pluginRoot, { recursive: true, mode: 0o700 });
        fs.renameSync(temp, finalDirectory);
        fsyncDirectory(pluginRoot);
        fsyncDirectory(root);
      } catch (error) {
        try {
          fs.rmSync(temp, { recursive: true, force: true });
        } catch {
          // Leave an inert temp directory behind; sweepInterrupted removes it later.
        }
        throw error;
      }
      return { relativePath: 'manifest.json', sha256, bytes: bytes.length };
    },
    read(pluginId: string, version: string): PluginInstalledFileRead {
      const directory = versionDirectory(pluginId, version);
      let fd: number | undefined;
      try {
        // O_NOFOLLOW on the version directory and the file reject symlink swaps.
        const dirFd = fs.openSync(directory, DIRECTORY_FLAGS);
        fs.closeSync(dirFd);
        fd = fs.openSync(join(directory, 'manifest.json'), FILE_FLAGS);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return { status: 'unreadable', reason: 'not_a_file' };
        if ((stat.mode & 0o777) !== 0o600) return { status: 'insecure', reason: 'insecure_mode' };
        if (stat.size <= 0 || stat.size > 65536)
          return { status: 'unreadable', reason: 'invalid_size' };
        const bytes = fs.readFileSync(fd);
        return {
          status: 'ok',
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')
          return { status: 'missing', reason: 'missing_file' };
        return { status: 'unreadable', reason: 'unreadable_file' };
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    },
  };
}

/** Presence-only view of owner-configured environment credential references. */
export function createEnvironmentCredentialReferences(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PluginCredentialReferencePort {
  return {
    available: (reference) => {
      if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(reference)) return false;
      const value = env[reference];
      return typeof value === 'string' && value.trim() !== '';
    },
  };
}
