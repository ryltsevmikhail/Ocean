import { codingCapabilities, type CodingApprovalBinding } from '@runnets/domain';
import type { CodingApprovalTransaction } from './coding-approval.js';
import type { ProjectLeasePort } from './coding-ports.js';
import type { ToolJournalPort } from './tools.js';

export function codingApprovalAdmission(
  binding: CodingApprovalBinding,
  tx: CodingApprovalTransaction,
  deps: Readonly<{ ownerId: string; leases: ProjectLeasePort; journal: ToolJournalPort }>,
): boolean {
  const task = tx.task?.(binding.taskId);
  const worktree = tx.worktree?.(binding.taskId);
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
    !deps.leases.owns(worktree.lease) ||
    binding.operation === 'apply' ||
    !deps.journal.inspectPending ||
    deps.journal.inspectPending().length > 0 ||
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
