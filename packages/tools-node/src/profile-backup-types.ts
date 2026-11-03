import type {
  CodingBackupInventory,
  DesktopAssetInventory,
  ProfileBackupAssetIdentity,
} from '@runnets/domain';
import type { CodingWorktreeAssetCatalog } from './coding-backup-worktrees.js';
import type { CodingRecoveryAssetCatalog } from './coding-recovery-graph.js';
import type { CodingDependencyCatalog } from './coding-dependency-types.js';
import type { DesktopAssetCatalog } from './desktop-assets.js';
export interface ProfileBackupAssetCatalog {
  readonly format: 2;
  readonly inventory: CodingBackupInventory;
  readonly desktopInventory: DesktopAssetInventory;
  readonly worktrees: CodingWorktreeAssetCatalog;
  readonly recovery: CodingRecoveryAssetCatalog;
  readonly dependencies: CodingDependencyCatalog;
  readonly desktop: DesktopAssetCatalog | null;
  readonly git: readonly {
    readonly slot: string;
    readonly kind: 'ready' | 'partial';
    readonly sha256: string;
  }[];
  readonly hash: string;
}
export interface ProfileBackupAssets {
  readonly identity: ProfileBackupAssetIdentity;
  readonly catalog: ProfileBackupAssetCatalog;
}
export interface ProfileBackupSource {
  readonly inventory: CodingBackupInventory;
  readonly desktop: DesktopAssetInventory;
  readonly profile: string;
  readonly managed: string;
  readonly databaseBytes: number;
}
