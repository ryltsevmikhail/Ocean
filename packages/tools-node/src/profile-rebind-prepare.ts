import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  DesktopBinding,
  ProfileRebindMaterialization,
  ProfileRebindRecord,
} from '@runnets/domain';
import { restoredRebindSource, type RestoreSnapshotReader } from './profile-rebind-source.js';
import { restoreCodingDependencyTask } from './coding-dependency-archive.js';
import { withProfileArchive } from './profile-backup-verify.js';
import { profileArchiveContext } from './profile-archive-context.js';
import { profileManifestCharge } from './profile-backup-accounting.js';
import { desktopRootIdentity, restoreDesktopAssets } from './desktop-assets.js';
import { attachRebindGit } from './profile-rebind-git.js';
import { rebindSync, rebindWrite } from './profile-rebind-io.js';
import { verifyReboundTree } from './profile-rebind-tree.js';
import { codingTree } from './coding-tree.js';

export async function prepareRebind(
  profile: string,
  read: RestoreSnapshotReader,
  record: ProfileRebindRecord,
): Promise<ProfileRebindMaterialization> {
  if (record.state !== 'preparing' || !record.projectLease || !record.worktreeLease)
    throw Error('rebind_intent_required');
  const p = record.preview,
    plan = p.plan;
  const witnessRoot = p.origin.manifest.lineage
    ? join(profile, 'restore-lineage')
    : join(profile, 'assets/evidence');
  await codingTree(plan.project.root, plan.project.baseCommit);
  const source = withProfileArchive(join(profile, 'restore-origin'), () =>
    withProfileArchive(witnessRoot, () => {
      const source = restoredRebindSource(profile, p.origin, p.originalTask, read);
      if (source.witness !== plan.evidenceWitness || source.manifest.hash !== plan.virtualHash)
        throw Error('stale_coding_asset');
      const budget = profileArchiveContext.getStore()!.budget;
      const copy = profileManifestCharge(source.manifest);
      // Distinct combined archive and materialized occurrence: neither is deduplicated with evidence.
      budget.charge('rebind-combined:' + plan.assetDirectory, copy);
      budget.charge('rebind-tree:' + plan.assetDirectory, copy);
      budget.charge('rebind-git:' + plan.assetDirectory, {
        stored: 16777216,
        logical: 16777216,
        entries: 10000,
        metadata: 1048576,
      });
      const registration = JSON.stringify([plan.registration]);
      budget.charge('rebind-registration:' + profile, {
        stored: Buffer.byteLength(registration),
        logical: Buffer.byteLength(registration),
        entries: 1,
        metadata: Buffer.byteLength(registration),
      });
      if (source.catalog.desktop) {
        const extra = Buffer.byteLength(JSON.stringify(source.catalog.desktop.inventory));
        const desktop = profileManifestCharge(source.catalog.desktop.manifest);
        budget.charge('rebind-desktop:' + plan.assetDirectory, {
          ...desktop,
          stored: desktop.stored + extra,
          logical: desktop.logical + extra,
          metadata: desktop.metadata + extra,
          entries: desktop.entries + 1,
        });
      }
      restoreCodingDependencyTask(
        join(source.archive, 'dependencies'),
        p.originalTask.id,
        plan.assetDirectory,
      );
      let desktop: DesktopBinding | null = null;
      if (plan.desktop && source.catalog.desktop) {
        restoreDesktopAssets(join(source.archive, 'desktop'), dirname(plan.desktop.root));
        desktop = {
          profileId: p.origin.profileId,
          root: plan.desktop.root,
          identity: desktopRootIdentity(plan.desktop.root),
          originalRoot: source.catalog.desktop.inventory.binding!.originalRoot,
        };
      }
      return { ...source, desktop, registration };
    }),
  );
  fs.renameSync(join(plan.managedDirectory, 'workspace'), plan.worktree.root);
  fs.symlinkSync(basename(plan.worktree.root), join(plan.managedDirectory, 'workspace'));
  rebindSync(plan.managedDirectory);
  const task = {
    ...p.originalTask,
    id: p.successorTaskId,
    projectRoot: plan.project.root,
    baseCommit: plan.project.baseCommit,
    worktreeRoot: plan.worktree.root,
    status: 'reserved' as const,
    policyVersion: 1 as const,
    policy: p.selection.policy,
    lease: record.projectLease,
  };
  await attachRebindGit(task, plan);
  verifyReboundTree(plan, source.manifest);
  rebindWrite(join(profile, 'coding-projects.json'), source.registration);
  rebindSync(profile);
  return {
    task,
    worktree: {
      ...plan.worktree,
      taskId: task.id,
      workspaceId: task.workspaceId,
      projectRoot: task.projectRoot,
      baseCommit: task.baseCommit,
      state: 'ready',
      lease: record.worktreeLease,
    },
    desktop: source.desktop,
    restoredTreeHash: plan.treeHash,
    virtualHash: plan.virtualHash,
  };
}
