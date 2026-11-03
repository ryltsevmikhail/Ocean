import type { ProfileRebindRecord, ProfileRebindMaterialization } from '@runnets/domain';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function validateRebindResult(r: ProfileRebindRecord, result: ProfileRebindMaterialization) {
  const p = r.preview,
    t = result.task,
    w = result.worktree,
    old = p.originalTask;
  if (
    t.id !== p.successorTaskId ||
    t.workspaceId !== old.workspaceId ||
    t.ownerRoomId !== old.ownerRoomId ||
    t.devBotId !== old.devBotId ||
    t.reviewRoomId !== old.reviewRoomId ||
    t.reviewBotId !== old.reviewBotId ||
    t.projectRoot !== p.plan.project.root ||
    t.baseCommit !== p.selection.baseCommit ||
    t.worktreeRoot !== p.plan.worktree.root ||
    t.status !== 'reserved' ||
    t.policyVersion !== 1 ||
    !equal(t.policy, p.selection.policy) ||
    !equal(t.lease, r.projectLease) ||
    w.taskId !== t.id ||
    w.workspaceId !== t.workspaceId ||
    w.projectRoot !== t.projectRoot ||
    w.baseCommit !== t.baseCommit ||
    w.root !== t.worktreeRoot ||
    w.branch !== p.plan.worktree.branch ||
    w.gitCommonDir !== p.plan.worktree.gitCommonDir ||
    w.state !== 'ready' ||
    !equal(w.lease, r.worktreeLease) ||
    result.restoredTreeHash !== p.plan.treeHash ||
    result.virtualHash !== p.plan.virtualHash ||
    (p.plan.desktop
      ? result.desktop?.profileId !== p.origin.profileId ||
        result.desktop.root !== p.plan.desktop.root
      : result.desktop !== null)
  )
    throw Error('rebind_result_mismatch');
}
