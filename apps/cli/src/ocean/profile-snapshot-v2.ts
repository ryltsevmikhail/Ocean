import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { ProfileBackupManifest } from '@runnets/domain';
import {
  snapshotCodingDatabase,
  inspectDatabase,
  readCodingBackupInventory,
  readDesktopBackupInventory,
} from '@runnets/store-sqlite';
import {
  captureProfileBackupAssets,
  copyProfileBackupDatabase,
  prepareProfileBackupAssets,
  type PreparedProfileBackup,
  restoreProfileBackupAssets,
  ProfileBackupOutput,
  profileBackupDatabaseIdentity,
  verifyProfileBackupEnvelope,
  verifyProfileBackupOutput,
  type ProfileBackupCapture,
} from '@runnets/tools-node';
import { assertProfileFiles, absolutePath, atomicPrivateJson, syncFile } from './private-files.js';
import { CLI_VERSION } from '../version.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validateDatabase(path: string, manifest: Extract<ProfileBackupManifest, { format: 2 }>) {
  const inspection = inspectDatabase(path);
  if (
    inspection.status !== 'ok' ||
    JSON.stringify(inspection.summary) !== JSON.stringify(manifest.summary) ||
    readCodingBackupInventory(path).hash !== manifest.assets.codingInventory ||
    hash(readDesktopBackupInventory(path)) !== manifest.assets.desktopInventory
  )
    throw Error('invalid_backup');
}
export async function backupProfileV2(
  profile: string,
  to: string,
  managed = join(homedir(), '.local/state/ocean-worktrees'),
): Promise<Extract<ProfileBackupManifest, { format: 2 }>> {
  assertProfileFiles(profile);
  absolutePath(to);
  if (!fs.existsSync(join(profile, 'runtime.sqlite'))) throw Error('profile_missing');
  if (to === profile || to.startsWith(profile + '/'))
    throw Error('invalid_profile_backup_destination');
  const path = join(to, 'runtime.sqlite');
  let output: ProfileBackupOutput | undefined,
    prepared: PreparedProfileBackup | undefined,
    capture: ProfileBackupCapture | undefined,
    result: Extract<ProfileBackupManifest, { format: 2 }> | undefined;
  try {
    await snapshotCodingDatabase(
      join(profile, 'runtime.sqlite'),
      (inventory, desktop, databaseBytes) => {
        prepared = prepareProfileBackupAssets(
          { inventory, desktop, profile, managed, databaseBytes },
          join(to, 'assets'),
        );
        output = new ProfileBackupOutput(to);
        return path;
      },
      async () => {
        capture = await captureProfileBackupAssets(prepared!, join(to, 'assets'));
        return capture;
      },
      ({ summary, assets }, verifyFrozen) => {
        syncFile(path);
        result = {
          format: 2,
          createdAt: new Date().toISOString(),
          cli: CLI_VERSION,
          node: process.version,
          ...profileBackupDatabaseIdentity(path),
          summary,
          assets: assets.identity,
        };
        output!.write('snapshot.json', result);
        verifyProfileBackupOutput(output!, (manifest) => validateDatabase(path, manifest));
        assets.verify();
        return Promise.resolve(() => {
          assets.publish(verifyFrozen);
          output!.publish();
        });
      },
    );
    if (!result) throw Error('invalid_backup');
    try {
      atomicPrivateJson(join(profile, 'last-backup.json'), {
        createdAt: result.createdAt,
        sha256: result.sha256,
      });
    } catch {
      /* Receipt is informational only. */
    }
    return result;
  } finally {
    capture?.close();
    prepared?.close();
    output?.close();
  }
}
export function restoreProfileV2(
  from: string,
  to: string,
): Extract<ProfileBackupManifest, { format: 2 }> {
  absolutePath(from);
  absolutePath(to);
  if (to === from || to.startsWith(from + '/')) throw Error('invalid_profile_backup_destination');
  let output: ProfileBackupOutput | undefined;
  try {
    const result = verifyProfileBackupEnvelope(from, (manifest) => {
      validateDatabase(join(from, 'runtime.sqlite'), manifest);
      output = new ProfileBackupOutput(to);
      output.write('restore-guard.json', { state: 'restoring' });
      copyProfileBackupDatabase(join(from, 'runtime.sqlite'), output, manifest);
      syncFile(join(to, 'runtime.sqlite'));
      validateDatabase(join(to, 'runtime.sqlite'), manifest);
      restoreProfileBackupAssets(join(from, 'assets'), join(to, 'assets'), manifest.assets);
      atomicPrivateJson(join(to, 'restore-guard.json'), {
        state: 'ready',
        format: 2,
        restoredAt: new Date().toISOString(),
        snapshotAt: manifest.createdAt,
        sha256: manifest.sha256,
        mode: 'text_only_by_confirmation',
      });
    });
    output!.publish();
    return result;
  } finally {
    output?.close();
  }
}
