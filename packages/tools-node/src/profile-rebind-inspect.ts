import * as fs from 'node:fs';
import { basename, join } from 'node:path';
import { desktopUuid, type CodingTask, type ProfileRebindPlan } from '@runnets/domain';
import type { ProfileRebindFiles } from '@runnets/application';
import { GitCodingProject } from './coding-project.js';
import { GitCodingWorktrees } from './coding-worktree.js';
import { GitCodingApplyProject } from './coding-apply-project.js';
import { rebindDirectoryIdentity } from './profile-rebind-io.js';
import { codingTree } from './coding-tree.js';
import { observeRebindFiles } from './profile-rebind-observe.js';
import { restoredRebindSource, type RestoreSnapshotReader } from './profile-rebind-source.js';

export async function inspectRebind(
  profile: string,
  read: RestoreSnapshotReader,
  input: Parameters<ProfileRebindFiles['inspect']>[0],
): Promise<ProfileRebindPlan> {
  const { origin, task, selection, epochId, ownerId, successorTaskId } = input;
  if (
    !desktopUuid(epochId) ||
    !desktopUuid(successorTaskId) ||
    ownerId !== origin.profileId + ':' + epochId
  )
    throw Error('invalid_rebind_identity');
  const before = restoredRebindSource(profile, origin, task, read);
  const selected = await new GitCodingProject().inspect(selection.projectRoot);
  if (
    !selected.clean ||
    selected.root !== selection.projectRoot ||
    selected.baseCommit !== selection.baseCommit
  )
    throw Error('rebind_project_changed');
  await codingTree(selected.root, selected.baseCommit);
  const selectedTree = await new GitCodingApplyProject().tree(selected.root, selected.baseCommit);
  if (selectedTree !== selection.treeHash) throw Error('rebind_project_changed');
  const assetDirectory = join(profile, 'rebind-' + epochId);
  const managedDirectory = join(assetDirectory, 'materialized/tree');
  const successor: CodingTask = {
    ...task,
    id: successorTaskId,
    projectRoot: selected.root,
    baseCommit: selected.baseCommit,
    worktreeRoot: null,
    lease: { ...task.lease, ownerId, taskId: successorTaskId, projectRoot: selected.root },
  };
  const worktree = await new GitCodingWorktrees(managedDirectory).plan(successor);
  const after = restoredRebindSource(profile, origin, task, read);
  if (before.witness !== after.witness) throw Error('stale_coding_asset');
  const mounts = after.dependency.mappings.map((m) => ({
    target: m.target,
    source: m.target.startsWith('/workspace/')
      ? join(worktree.root, m.target.slice('/workspace/'.length))
      : join(managedDirectory, m.target.slice(1)),
  }));
  // A consumed attempt may already have outputs. Their presence is verified by prepare/verify,
  // never taken as permission to reuse or retry an interrupted attempt.
  if (fs.realpathSync(profile) !== profile || basename(worktree.root) === 'workspace')
    throw Error('invalid_rebind_identity');
  return {
    project: {
      root: selected.root,
      baseCommit: selected.baseCommit,
      treeHash: selectedTree,
      witness:
        rebindDirectoryIdentity(selected.root) +
        ':' +
        rebindDirectoryIdentity(worktree.gitCommonDir),
    },
    worktree,
    managedDirectory,
    assetDirectory,
    treeHash: after.tree.treeHash!,
    // Standard worktree layout: the deterministic slot names both temporary root and new admin.
    gitTemporaryRoot: join(assetDirectory, basename(worktree.root)),
    gitAdministration: join(worktree.gitCommonDir, 'worktrees', basename(worktree.root)),
    virtualHash: after.manifest.hash,
    changesetHashes: after.catalog.inventory.changesets
      .filter((c) => c.taskId === task.id)
      .map((c) => c.hash),
    registration: {
      id: 'rebind-' + epochId,
      root: selected.root,
      testPresets: selection.policy.testPresets,
      ...(mounts.some((m) => m.target.startsWith('/workspace/')) && {
        dependencyProjectRoot: worktree.root,
      }),
      mounts,
    },
    desktop: after.catalog.desktop
      ? {
          root: join(profile, 'desktop-' + epochId, 'tree'),
          archiveHash: after.catalog.desktop.hash,
        }
      : null,
    evidenceWitness: after.witness,
    observations: observeRebindFiles(selected.root, after.catalog.inventory, task.id),
    inertAssets: [
      { kind: 'original-git-administration-and-index', identity: after.tree.slot },
      { kind: 'original-worktree-git-pointer', identity: after.tree.treeHash! },
      { kind: 'original-recovery-journal', identity: after.catalog.recovery.hash },
      ...after.catalog.worktrees.worktrees
        .filter((t) => t.taskId !== task.id)
        .map((t) => ({ kind: 'unselected-worktree', identity: t.slot })),
    ],
  };
}
