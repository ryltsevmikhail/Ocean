import { backupProfileV2, restoreProfileV2 } from './profile-snapshot-v2.js';
import { readSnapshotManifest } from './snapshot-manifest.js';
import type { ProfileBackupManifest } from '@runnets/domain';
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
import { inspectDatabase, type DatabaseSummary } from '@runnets/store-sqlite';
import { atomicPrivateJson, absolutePath, assertPrivate, syncFile } from './private-files.js';

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
function restoreProfileLegacy(from: string, to: string, manifest: Snapshot): Snapshot {
  absolutePath(from);
  absolutePath(to);
  assertPrivate(from, true);
  assertPrivate(join(from, 'snapshot.json'), false);
  assertPrivate(join(from, 'runtime.sqlite'), false);
  try {
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

/** New backups bind the full selected graph; format 1 remains readable as metadata-only evidence. */
export async function backupProfile(
  profile: string,
  to: string,
  options?: { managedDirectory?: string },
): Promise<ProfileBackupManifest> {
  return backupProfileV2(profile, to, options?.managedDirectory);
}
export function restoreProfile(from: string, to: string): ProfileBackupManifest {
  absolutePath(from);
  assertPrivate(from, true);
  assertPrivate(join(from, 'snapshot.json'), false);
  try {
    const manifest = readSnapshotManifest(from) as Snapshot | { format: 2 };
    return manifest.format === 2
      ? restoreProfileV2(from, to)
      : restoreProfileLegacy(from, to, manifest);
  } catch (error) {
    if (
      error instanceof Error &&
      ['destination_exists', 'invalid_input', 'insecure_permissions'].includes(error.message)
    )
      throw error;
    throw Error('invalid_backup');
  }
}
