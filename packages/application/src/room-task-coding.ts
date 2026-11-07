import type { RoomAuthorityRead } from './room-task-authority.js';
import type { RoomTaskRoot } from './room-task-records.js';
/** Stored assignment and lease identities only; live lease ports guard actual worktree I/O. */
export function roomCodingTask(
  tx: RoomAuthorityRead,
  root: RoomTaskRoot,
  sha256?: (s: string) => string,
) {
  const id = root.rootPayload.mandate.codingTaskId,
    rt = tx.roomTasks;
  const task = id && rt?.codingTask(id),
    worktree = id && rt?.codingWorktree(id);
  if (
    !task ||
    !worktree ||
    task.status !== 'reserved' ||
    task.workspaceId !== root.workspaceId ||
    task.ownerRoomId !== root.roomId ||
    !task.worktreeRoot ||
    worktree.state !== 'ready' ||
    worktree.taskId !== task.id ||
    worktree.workspaceId !== task.workspaceId ||
    worktree.projectRoot !== task.projectRoot ||
    worktree.root !== task.worktreeRoot ||
    worktree.baseCommit !== task.baseCommit ||
    ![task.lease, worktree.lease].every(
      (lease) =>
        lease.ownerId === root.rootPayload.ownerId &&
        lease.kind === 'coding' &&
        lease.taskId === task.id &&
        !!lease.token,
    ) ||
    task.lease.projectRoot !== task.projectRoot ||
    worktree.lease.projectRoot !== worktree.root ||
    (root.rootPayload.mandate.projectId !== null &&
      root.rootPayload.mandate.projectId !== sha256?.(task.projectRoot))
  )
    return null;
  return { task, worktree };
}
