/** Snapshots contain history, never environment credentials or workspace files. */
import {
  existsSync,
  copyFileSync,
  constants,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { inspectDatabase, snapshotDatabase, type DatabaseSummary } from '@runnets/store-sqlite';
import {
  atomicPrivateJson,
  absolutePath,
  assertPrivate,
  assertProfileFiles,
  syncFile,
} from './private-files.js';
import { CLI_VERSION } from '../version.js';

interface Snapshot {
  readonly format: 1;
  readonly createdAt: string;
  readonly cli: string;
  readonly node: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly summary: DatabaseSummary;
}
export function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function createDirectory(path: string): void {
  absolutePath(path);
  // Parent must exist; never create or overwrite an unrelated directory.
  if (existsSync(path)) throw new Error('destination_exists');
  mkdirSync(path, { mode: 0o700 });
}
function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  syncFile(path);
}
export async function backupProfile(profile: string, to: string): Promise<Snapshot> {
  assertProfileFiles(profile);
  if (!existsSync(join(profile, 'runtime.sqlite'))) throw new Error('profile_missing');
  createDirectory(to);
  try {
    const path = join(to, 'runtime.sqlite');
    const summary = await snapshotDatabase(join(profile, 'runtime.sqlite'), path);
    syncFile(path);
    const manifest: Snapshot = {
      format: 1,
      createdAt: new Date().toISOString(),
      cli: CLI_VERSION,
      node: process.version,
      sha256: digest(path),
      bytes: readFileSync(path).length,
      summary,
    };
    writePrivate(join(to, 'snapshot.json'), manifest);
    syncFile(to);
    syncFile(dirname(to));
    // Receipt is informational, never used as proof a backup remains valid.
    try {
      atomicPrivateJson(join(profile, 'last-backup.json'), {
        createdAt: manifest.createdAt,
        sha256: manifest.sha256,
      });
    } catch {
      /* Snapshot remains verified. */
    }
    return manifest;
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
}
export function restoreProfile(from: string, to: string): Snapshot {
  absolutePath(from);
  absolutePath(to);
  assertPrivate(from, true);
  assertPrivate(join(from, 'snapshot.json'), false);
  assertPrivate(join(from, 'runtime.sqlite'), false);
  let manifest: Snapshot;
  try {
    manifest = JSON.parse(readFileSync(join(from, 'snapshot.json'), 'utf8')) as Snapshot;
    if (
      manifest.format !== 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes <= 0 ||
      ![5, 6, 7, 8, 9, 10, 11, 12].includes(manifest.summary.schema) ||
      !Number.isFinite(Date.parse(manifest.createdAt))
    )
      throw new Error();
  } catch {
    throw new Error('invalid_backup');
  }
  createDirectory(to);
  try {
    writePrivate(join(to, 'restore-guard.json'), { state: 'restoring' });
    const path = join(to, 'runtime.sqlite');
    copyFileSync(join(from, 'runtime.sqlite'), path, constants.COPYFILE_EXCL);
    // copyFile preserves the already-verified 0600 source mode.
    if (digest(path) !== manifest.sha256 || readFileSync(path).length !== manifest.bytes)
      throw new Error('invalid_backup');
    const inspection = inspectDatabase(path);
    if (
      inspection.status !== 'ok' ||
      inspection.summary.externalCodingAssets ||
      inspection.summary.externalDesktopAssets ||
      JSON.stringify(inspection.summary) !== JSON.stringify(manifest.summary)
    )
      throw new Error('invalid_backup');
    syncFile(path);
    syncFile(to);
    // Install guard before the directory can be considered a usable restored profile.
    atomicPrivateJson(join(to, 'restore-guard.json'), {
      state: 'ready',
      format: 1,
      restoredAt: new Date().toISOString(),
      snapshotAt: manifest.createdAt,
      sha256: manifest.sha256,
      mode: 'text_only_by_confirmation',
    });
    syncFile(dirname(to));
    return manifest;
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
}
