import type { ProfileBackupManifest } from './profile-backup.js';
import type { CodingBackupInventory } from './coding-backup.js';
import type { DesktopAssetInventory } from './desktop-assets.js';
import type { CodingTask } from './coding-task.js';
import type { ProfileRebindRecord, ProfileRebindObservation } from './profile-rebind.js';
export interface RestorationBackupState {
  readonly origin: RestoreOrigin | null;
  readonly origins: readonly RestoreOrigin[];
  readonly records: readonly ProfileRebindRecord[];
  readonly observations: readonly ProfileRebindObservation[];
  readonly activeRequestId: string | null;
  readonly retired: readonly {
    readonly originHash: string;
    readonly requestId: string;
    readonly retiredBy: string;
    readonly snapshotId: string;
  }[];
}
export interface RestoredSnapshotState {
  readonly coding: CodingBackupInventory;
  readonly desktop: DesktopAssetInventory;
  readonly tasks: readonly CodingTask[];
  readonly restoration: RestorationBackupState;
}
/** Snapshot provenance persists independently of mutable conversation state and filesystem guards. */
export interface RestoreOrigin {
  readonly version: 1;
  readonly snapshotId: string;
  readonly manifest: Extract<ProfileBackupManifest, { format: 2 }>;
  readonly profileRoot: string;
  readonly profileId: string;
  readonly sourceOwners: readonly string[];
}
