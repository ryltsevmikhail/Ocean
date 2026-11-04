import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { ProfileBackupManifest, RestorationBackupState } from '@runnets/domain';
import {
  snapshotCodingDatabase,
  inspectDatabase,
  readCodingBackupInventory,
  readDesktopBackupInventory,
  readProfileRestoreSnapshot,
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
  verifyRestoredProfileBaseline,
  verifySnapshotGraph,
  preserveProfileRestoreOrigin,
  preserveProfileRestoreLineage,
  type ProfileBackupCapture,
} from '@runnets/tools-node';
import { assertProfileFiles, absolutePath, atomicPrivateJson, syncFile } from './private-files.js';
import { CLI_VERSION } from '../version.js';
import { installRestoreOrigin } from './restore-origin.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The live ready epoch owns its materialized managed directory; no caller argument can name it. */
function liveManagedDirectory(
  profile: string,
  restoration: RestorationBackupState,
  fallback: string,
): string {
  if (!restoration.activeRequestId) return fallback;
  const active = restoration.records.find((r) => r.requestId === restoration.activeRequestId);
  if (
    !active ||
    active.state !== 'ready' ||
    !active.result ||
    active.preview.plan.managedDirectory !==
      join(profile, 'rebind-' + active.preview.epochId, 'materialized/tree')
  )
    throw Error('invalid_execution_epoch');
  return active.preview.plan.managedDirectory;
}
/** Full summary and, when present, the exact live partition plus bounded parent proof are checked. */
function validateDatabase(
  directory: string,
  manifest: Extract<ProfileBackupManifest, { format: 2 }>,
  incomplete: boolean,
  assets = 'archive',
): void {
  if (assets !== 'archive' && assets !== 'evidence') throw Error('invalid_backup');
  const path = join(directory, 'runtime.sqlite'),
    inspection = inspectDatabase(path);
  if (
    inspection.status !== 'ok' ||
    JSON.stringify(inspection.summary) !== JSON.stringify(manifest.summary)
  )
    throw Error('invalid_backup');
  if (manifest.lineage) {
    verifySnapshotGraph(
      {
        database: path,
        assets: join(directory, 'assets', assets === 'archive' ? '' : 'evidence'),
        lineage: join(directory, assets === 'archive' ? 'lineage' : 'restore-lineage'),
      },
      manifest,
      readProfileRestoreSnapshot,
      [],
      incomplete,
    );
    return;
  }
  if (
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
    restoration: RestorationBackupState | undefined,
    result: Extract<ProfileBackupManifest, { format: 2 }> | undefined;
  try {
    await snapshotCodingDatabase(
      join(profile, 'runtime.sqlite'),
      (inventory, desktop, databaseBytes, state, plugins) => {
        restoration = state;
        prepared = prepareProfileBackupAssets(
          {
            inventory,
            desktop,
            plugins,
            profile,
            managed: liveManagedDirectory(profile, state, managed),
            databaseBytes,
            restoration: state,
            readSnapshot: readProfileRestoreSnapshot,
          },
          join(to, 'assets'),
        );
        output = new ProfileBackupOutput(to);
        return path;
      },
      async () => {
        capture = await captureProfileBackupAssets(prepared!, join(to, 'assets'));
        return capture;
      },
      ({ summary, assets }, verifyFrozen, verifyFrozenTerminal) => {
        if (!restoration) throw Error('invalid_backup');
        syncFile(path);
        result = {
          format: 2,
          createdAt: new Date().toISOString(),
          cli: CLI_VERSION,
          node: process.version,
          ...profileBackupDatabaseIdentity(path),
          summary,
          assets: assets.identity,
          ...(assets.lineage ? { lineage: assets.lineage } : {}),
        };
        output!.write('snapshot.json', result);
        verifyProfileBackupOutput(output!, (manifest) => validateDatabase(to, manifest, true));
        assets.verify();
        return Promise.resolve(() => {
          assets.publish(verifyFrozen, verifyFrozenTerminal);
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
      validateDatabase(from, manifest, false);
      output = new ProfileBackupOutput(to);
      output.write('restore-guard.json', { state: 'restoring' });
      preserveProfileRestoreOrigin(from, join(to, 'restore-origin'), manifest);
      if (manifest.lineage)
        preserveProfileRestoreLineage(from, join(to, 'restore-lineage'), manifest);
      copyProfileBackupDatabase(join(from, 'runtime.sqlite'), output, manifest);
      syncFile(join(to, 'runtime.sqlite'));
      restoreProfileBackupAssets(join(from, 'assets'), join(to, 'assets'), manifest.assets, to);
      installRestoreOrigin(to, manifest);
      atomicPrivateJson(join(to, 'restore-guard.json'), {
        state: 'ready',
        format: 2,
        restoredAt: new Date().toISOString(),
        snapshotAt: manifest.createdAt,
        sha256: manifest.sha256,
        mode: 'text_only_by_confirmation',
      });
      verifyRestoredProfileBaseline(to, manifest, readProfileRestoreSnapshot);
    });
    output!.publish();
    return result;
  } finally {
    output?.close();
  }
}
