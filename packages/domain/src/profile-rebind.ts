import type { CodingTask, ProjectLease } from './coding-task.js';
import type { CodingPolicy } from './coding-policy.js';
import type { CodingWorktree, WorktreePlan } from './changeset.js';
import type { DesktopBinding } from './desktop-assets.js';
import type { RestoreOrigin } from './restore-origin.js';
export interface ProfileRebindSelection {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly profileId: string;
  readonly snapshotId: string;
  readonly sourceOwnerId: string;
  readonly taskId: string;
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly treeHash: string;
  readonly policy: CodingPolicy;
}
export interface ProfileRebindHold {
  readonly kind: string;
  readonly id: string;
  readonly outcome: string;
  readonly scope: 'global' | 'operation';
}
export interface ProfileRebindComparison {
  readonly changesetHash: string;
  readonly comparison: 'before' | 'after' | 'mixed' | 'conflicting' | 'unknown';
  readonly scope: 'selected-project-only';
  readonly settlesEffect: false;
}
export interface ProfileRebindObservation {
  readonly id: string;
  readonly selection: ProfileRebindSelection;
  readonly observedAt: number;
  readonly holds: readonly ProfileRebindHold[];
  readonly observations: readonly ProfileRebindComparison[];
}
export interface ProfileRebindRegistration {
  readonly id: string;
  readonly root: string;
  readonly testPresets: CodingPolicy['testPresets'];
  readonly dependencyProjectRoot?: string;
  readonly mounts: readonly { readonly source: string; readonly target: string }[];
}
export interface ProfileRebindPlan {
  readonly project: {
    readonly root: string;
    readonly baseCommit: string;
    readonly treeHash: string;
    readonly witness: string;
  };
  readonly worktree: WorktreePlan;
  readonly managedDirectory: string;
  readonly assetDirectory: string;
  readonly gitTemporaryRoot: string;
  readonly gitAdministration: string;
  readonly treeHash: string;
  readonly virtualHash: string;
  readonly changesetHashes: readonly string[];
  readonly registration: ProfileRebindRegistration;
  readonly desktop: { readonly root: string; readonly archiveHash: string } | null;
  readonly evidenceWitness: string;
  readonly inertAssets: readonly { readonly kind: string; readonly identity: string }[];
  readonly observations: readonly ProfileRebindComparison[];
}
export interface ProfileRebindPreview {
  readonly selection: ProfileRebindSelection;
  readonly origin: RestoreOrigin;
  readonly originalTask: CodingTask;
  readonly epochId: string;
  readonly ownerId: string;
  readonly successorTaskId: string;
  readonly plan: ProfileRebindPlan;
  readonly holds: readonly ProfileRebindHold[];
  readonly postSnapshotInterval: 'unknown-never-replayed';
}
export interface ProfileRebindMaterialization {
  readonly task: CodingTask;
  readonly worktree: CodingWorktree;
  readonly desktop: DesktopBinding | null;
  readonly restoredTreeHash: string;
  readonly virtualHash: string;
}
export interface ProfileRebindRecord {
  readonly requestId: string;
  readonly revision: number;
  readonly decisionId: string;
  readonly bindingDigest: string;
  readonly preview: ProfileRebindPreview;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: 'preview' | 'confirmed' | 'preparing' | 'ready' | 'held' | 'refused';
  readonly projectLease: ProjectLease | null;
  readonly worktreeLease: ProjectLease | null;
  readonly result: ProfileRebindMaterialization | null;
  readonly reason: string | null;
}
