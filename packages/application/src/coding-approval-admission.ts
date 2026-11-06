import type { Clock } from './ports.js';
import { codingEffectAdmission, codingRoomBasis } from './coding-grant-admission.js';
import {
  canonicalJson,
  codingCapabilities,
  type CodingApproval,
  type CodingApprovalBinding,
} from '@runnets/domain';
import type { CodingApprovalTransaction } from './coding-approval.js';
import type { ProjectLeasePort } from './coding-ports.js';
import type { ToolJournalPort } from './tools.js';

export function codingApprovalAdmission(
  binding: CodingApprovalBinding,
  tx: CodingApprovalTransaction,
  deps: Readonly<{
    ownerId: string;
    leases: ProjectLeasePort;
    journal: ToolJournalPort;
    clock?: Clock;
  }>,
  approval?: CodingApproval,
): boolean {
  const at = deps.clock?.now().getTime();
  if (at === undefined) {
    const scope = tx.roomScope?.(binding.runId, NaN);
    if (scope !== null && scope !== undefined) return false;
  }
  const basis = codingRoomBasis(
    tx,
    binding,
    approval?.preview ?? '',
    at ?? Date.now(),
    approval?.status === 'consumed',
  );
  if (
    basis === false ||
    (approval?.roomBasis && canonicalJson(approval.roomBasis) !== canonicalJson(basis?.basis))
  )
    return false;
  const task = tx.task?.(binding.taskId);
  const worktree = tx.worktree?.(binding.taskId);
  const evidence =
    approval?.guardedDispatch === true
      ? codingEffectAdmission(tx, binding, approval.grantReference ?? null, approval.roomBasis)
      : undefined;
  if (
    !task ||
    !worktree ||
    worktree.state !== 'ready' ||
    worktree.root !== binding.worktreeRoot ||
    worktree.workspaceId !== binding.workspaceId ||
    worktree.taskId !== binding.taskId ||
    worktree.projectRoot !== task.projectRoot ||
    worktree.baseCommit !== task.baseCommit ||
    worktree.lease.projectRoot !== worktree.root ||
    worktree.lease.ownerId !== deps.ownerId ||
    worktree.lease.taskId !== task.id ||
    worktree.lease.kind !== 'coding' ||
    task.lease.taskId !== task.id ||
    task.lease.kind !== 'coding' ||
    task.lease.projectRoot !== task.projectRoot ||
    task.devBotId !== binding.botId ||
    task.ownerRoomId !== binding.roomId ||
    !deps.leases.owns(worktree.lease) ||
    binding.operation === 'apply' ||
    !deps.journal.inspectPending ||
    (deps.journal.inspectConflicts?.(evidence) ?? deps.journal.inspectPending()).some(
      (r) =>
        approval?.status !== 'consumed' ||
        !evidence ||
        !r.admission ||
        canonicalJson(r.admission) !== canonicalJson(evidence) ||
        r.id !== binding.invocationId ||
        r.taskRunId !== binding.runId ||
        r.attemptId !== binding.attemptId ||
        r.outcome !== 'started',
    ) ||
    task.lease.ownerId !== deps.ownerId ||
    task.projectRoot !== binding.projectRoot ||
    task.worktreeRoot === null ||
    task.worktreeRoot !== binding.worktreeRoot ||
    !tx.participates?.(binding.workspaceId, binding.roomId, binding.botId) ||
    !deps.leases.owns(task.lease)
  )
    return false;
  return codingCapabilities(task, binding).includes(
    binding.operation === 'write' ? 'propose_write' : 'run_test_preset',
  );
}
