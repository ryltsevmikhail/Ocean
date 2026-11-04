import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  ownSqliteRuntime,
  openSqliteStore,
  readCodingBackupInventory,
} from '@runnets/store-sqlite';
import type { ProfileBackupManifest } from '@runnets/domain';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** Called while the destination is incomplete; ownership precedes its first writable open. */
export function installRestoreOrigin(
  profile: string,
  manifest: Extract<ProfileBackupManifest, { format: 2 }>,
): void {
  const path = join(profile, 'runtime.sqlite');
  const inventory = readCodingBackupInventory(path);
  const release = ownSqliteRuntime(path);
  try {
    const store = openSqliteStore({ path });
    try {
      // Restored plugin metadata is inert: no connection, grant or consent may
      // survive the restore, so re-connection and re-grant are required before
      // any network call could be admitted.
      store.pluginConnections.invalidateRestored(new Date().toISOString());
      store.restoration.install({
        version: 1,
        snapshotId: hash(JSON.stringify(manifest)),
        manifest,
        profileRoot: profile,
        profileId: hash(profile),
        sourceOwners: [...new Set(inventory.tasks.map((task) => task.ownerId))].sort(),
      });
    } finally {
      store.close();
    }
  } finally {
    release();
  }
}
