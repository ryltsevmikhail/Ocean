import type { CodingTask } from '@runnets/domain';
import type { CodingApplyTransaction } from './coding-apply.js';
import type { ProjectLeasePort } from './coding-ports.js';
import type { ToolJournalPort } from './tools.js';
/** Owner application still requires live room/task/lease authority at claim time. */
export function codingApplyAdmission(
  task: CodingTask,
  tx: Pick<CodingApplyTransaction, 'participates' | 'worktree'>,
  deps: Readonly<{
    ownerId: string;
    restored: boolean;
    leases: Pick<ProjectLeasePort, 'owns'>;
    journal: Pick<ToolJournalPort, 'inspectPending'>;
  }>,
): boolean {
  const worktree = tx.worktree(task.id);
  return (
    !deps.restored &&
    task.status === 'reserved' &&
    task.lease.ownerId === deps.ownerId &&
    task.worktreeRoot !== null &&
    worktree !== null &&
    worktree.state === 'ready' &&
    worktree.root === task.worktreeRoot &&
    worktree.projectRoot === task.projectRoot &&
    worktree.baseCommit === task.baseCommit &&
    worktree.workspaceId === task.workspaceId &&
    worktree.lease.ownerId === deps.ownerId &&
    deps.leases.owns(task.lease) &&
    deps.leases.owns(worktree.lease) &&
    task.policy.devCapabilities.includes('project_read') &&
    task.policy.reviewCapabilities.includes('changeset_read') &&
    tx.participates(task.workspaceId, task.ownerRoomId, task.devBotId) &&
    tx.participates(task.workspaceId, task.reviewRoomId, task.reviewBotId) &&
    deps.journal.inspectPending !== undefined &&
    deps.journal.inspectPending().length === 0
  );
}
