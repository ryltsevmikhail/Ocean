import { join } from 'node:path';
import type {
  CodingTask,
  CodingAssetManifest,
  RestoreOrigin,
  RestoredSnapshotState,
} from '@runnets/domain';
import type { ProfileBackupAssetCatalog } from './profile-backup-types.js';
import { verifyRestoredProfileOrigin } from './profile-restore-verify.js';
import { profileTaskSource } from './profile-lineage-graph.js';
import { codingDependencyTaskManifest } from './coding-dependency-archive.js';
import { profileHash } from './profile-backup-output.js';

export type RestoreSnapshotReader = (descriptor: string) => RestoredSnapshotState;
export interface RebindSource {
  /** Verified archive assets that actually own this task: current evidence or a bounded parent. */
  archive: string;
  catalog: ProfileBackupAssetCatalog;
  tree: ProfileBackupAssetCatalog['worktrees']['worktrees'][number];
  dependency: ProfileBackupAssetCatalog['dependencies']['tasks'][number];
  manifest: CodingAssetManifest;
  witness: string;
}
export function restoredRebindSource(
  profile: string,
  origin: RestoreOrigin,
  task: CodingTask,
  read: RestoreSnapshotReader,
): RebindSource {
  const verified = verifyRestoredProfileOrigin(profile, origin.manifest, read);
  if (
    origin.profileRoot !== profile ||
    origin.snapshotId !== verified.snapshotId ||
    !verified.snapshot ||
    !verified.graph ||
    profileHash(verified.snapshot.tasks.find((t) => t.id === task.id) ?? null) !== profileHash(task)
  )
    throw Error('invalid_restore_origin');
  // The selector follows the exact verified lineage; archived epoch identity never becomes authority.
  const node = profileTaskSource(verified.graph, task.id),
    catalog = node.catalog,
    archive = node.assets,
    tree = catalog.worktrees.worktrees.find((t) => t.taskId === task.id),
    dependency = catalog.dependencies.tasks.find((t) => t.taskId === task.id);
  if (
    !tree ||
    tree.state !== 'ready' ||
    tree.presence !== 'captured' ||
    !tree.treeHash ||
    !dependency ||
    dependency.treeSelection !== 'captured' ||
    dependency.treeHash !== tree.treeHash
  )
    throw Error('restored_tree_not_executable');
  const manifest = codingDependencyTaskManifest(join(archive, 'dependencies'), task.id);
  if (manifest.hash !== dependency.virtualHash) throw Error('invalid_restore_origin');
  return {
    archive,
    catalog,
    tree,
    dependency,
    manifest,
    witness: profileHash([verified.profileWitness, verified.originWitness, catalog.hash]),
  };
}
