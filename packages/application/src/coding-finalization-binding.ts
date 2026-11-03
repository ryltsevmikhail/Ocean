import type {
  CodingFinalizationBinding,
  CodingFinalizationPreview,
  CodingFinalizationRecord,
  CodingFinalizationSelection,
  ProjectLease,
} from '@runnets/domain';
import type {
  CodingFinalizationStore,
  CodingFinalizationTransaction,
  ProjectLeaseReleasePort,
} from './coding-finalization-ports.js';
export interface FinalizationScope {
  readonly ownerId: string;
  readonly epochId: string | null;
  readonly leases: ProjectLeaseReleasePort;
  readonly digest: (text: string) => string;
}
export interface Selected {
  readonly task: NonNullable<ReturnType<CodingFinalizationTransaction['task']>>;
  readonly worktree: NonNullable<ReturnType<CodingFinalizationTransaction['worktree']>>;
  readonly assets: ReturnType<CodingFinalizationTransaction['assets']>;
}
export function finalizationSelectionOf(
  binding: CodingFinalizationBinding,
): CodingFinalizationSelection {
  return {
    workspaceId: binding.task.workspaceId,
    roomId: binding.task.ownerRoomId,
    requestId: binding.operationId,
    taskId: binding.task.id,
  };
}
export function sameFinalizationSelection(
  record: CodingFinalizationRecord,
  i: CodingFinalizationSelection,
): boolean {
  const b = record.preview.binding;
  return (
    record.requestId === i.requestId &&
    record.taskId === i.taskId &&
    b.task.workspaceId === i.workspaceId &&
    b.task.ownerRoomId === i.roomId
  );
}
/** Exact prepared reservation, owner/epoch/participants/lease and unresolved holds. */
export function selectFinalization(
  tx: CodingFinalizationTransaction,
  i: CodingFinalizationSelection,
  scope: FinalizationScope,
): Selected {
  const task = tx.task(i.taskId);
  if (
    !task ||
    task.workspaceId !== i.workspaceId ||
    task.ownerRoomId !== i.roomId ||
    task.lease.ownerId !== scope.ownerId
  )
    throw Error('finalization_scope_conflict');
  if (task.status !== 'reserved') throw Error('finalization_already_disabled');
  const worktree = tx.worktree(task.id);
  if (
    task.worktreeRoot === null ||
    !worktree ||
    worktree.state !== 'ready' ||
    worktree.root !== task.worktreeRoot ||
    worktree.taskId !== task.id ||
    worktree.projectRoot !== task.projectRoot ||
    worktree.baseCommit !== task.baseCommit ||
    worktree.workspaceId !== task.workspaceId ||
    worktree.lease.ownerId !== scope.ownerId
  )
    throw Error('finalization_scope_conflict');
  const active = tx.active(task.id);
  if (active && active.requestId !== i.requestId) throw Error('finalization_in_progress');
  if (
    !tx.participates(task.workspaceId, task.ownerRoomId, task.devBotId) ||
    !tx.participates(task.workspaceId, task.reviewRoomId, task.reviewBotId)
  )
    throw Error('finalization_scope_conflict');
  const holds = tx.holds(task.id);
  if (holds.length)
    throw Error(
      holds.some((hold) => hold.scope === 'global')
        ? 'finalization_effects_held'
        : 'finalization_worker_active',
    );
  if (!scope.leases.owns(task.lease) || !scope.leases.owns(worktree.lease))
    throw Error('finalization_lease_conflict');
  return { task, worktree, assets: tx.assets(task.id) };
}
export function finalizationBinding(
  i: CodingFinalizationSelection,
  s: Selected,
  scope: FinalizationScope,
): CodingFinalizationBinding {
  const task = s.task,
    registry = scope.leases.identity(),
    lease: ProjectLease = {
      ownerId: task.lease.ownerId,
      taskId: task.lease.taskId,
      requestId: task.lease.requestId,
      binding: task.lease.binding,
      kind: task.lease.kind,
      projectRoot: task.lease.projectRoot,
      token: task.lease.token,
    };
  return {
    version: 1,
    operationId: i.requestId,
    owner: { profileOwnerId: scope.ownerId, epochId: scope.epochId },
    task: {
      id: task.id,
      originalTaskId: task.id,
      workspaceId: task.workspaceId,
      ownerRoomId: task.ownerRoomId,
      devBotId: task.devBotId,
      reviewRoomId: task.reviewRoomId,
      reviewBotId: task.reviewBotId,
      createdAt: task.createdAt,
    },
    project: {
      root: task.projectRoot,
      baseCommit: task.baseCommit,
      worktreeRoot: s.worktree.root,
    },
    policy: { version: 1, digest: scope.digest(JSON.stringify(task.policy)) },
    assets: {
      changesets: [...s.assets.changesets],
      reviews: [...s.assets.reviews],
      evidence: [...s.assets.evidence],
    },
    lease: {
      token: lease.token,
      tokenHash: scope.digest(lease.token),
      holderHash: scope.digest(JSON.stringify(lease)),
      projectRoot: lease.projectRoot,
      ownerId: lease.ownerId,
      taskId: lease.taskId,
      requestId: lease.requestId,
      binding: lease.binding,
      kind: lease.kind,
      registry,
    },
  };
}
export function finalizationCurrent(
  store: CodingFinalizationStore,
  preview: CodingFinalizationPreview,
  expectedDigest: string,
  scope: FinalizationScope,
): Promise<boolean> {
  try {
    const i = finalizationSelectionOf(preview.binding);
    const binding = store.atomic((tx) =>
      finalizationBinding(i, selectFinalization(tx, i, scope), scope),
    );
    return Promise.resolve(
      expectedDigest === scope.digest(JSON.stringify(preview)) &&
        JSON.stringify(binding) === JSON.stringify(preview.binding),
    );
  } catch {
    return Promise.resolve(false);
  }
}
export function finalizationRef(binding: CodingFinalizationBinding, decisionId: string) {
  return {
    workspaceId: binding.task.workspaceId,
    roomId: binding.task.ownerRoomId,
    runId: 'finalize-' + binding.operationId,
    decisionId,
  };
}
