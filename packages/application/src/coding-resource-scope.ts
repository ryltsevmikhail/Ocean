import {
  validToolEffectAdmission,
  type ToolEffectAdmission,
  type CodingTask,
  type CodingWorktree,
} from '@runnets/domain';
const canonicalRoot = (root: string) =>
  root.startsWith('/') &&
  !root
    .split('/')
    .slice(1)
    .some((p) => !p || p === '.' || p === '..') &&
  ![...root].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
/** Conflict probe only: it never grants, claims or persists executable authority. */
export function codingResourceAdmission(
  projectRoot: string,
  projectId: string,
  worktree?: Readonly<{ id: string; root: string }>,
): ToolEffectAdmission | undefined {
  if (!canonicalRoot(projectRoot) || (worktree && !canonicalRoot(worktree.root))) return undefined;
  const admission: ToolEffectAdmission = {
    scope: {
      kind: 'resources',
      resources: [
        { kind: 'project-worktree', projectId, worktreeId: null },
        ...(worktree
          ? [{ kind: 'project-worktree' as const, projectId, worktreeId: worktree.id }]
          : []),
      ],
    },
    effectKind: 'mutation',
    grantReference: null,
    binding: { projectRoot, ...(worktree ? { worktreeRoot: worktree.root } : {}) },
  };
  return validToolEffectAdmission(admission) ? admission : undefined;
}
/** Durable binding facts only; callers additionally check current lease ownership. */
export function codingResourceWorktree(task: CodingTask, worktree: CodingWorktree | null): boolean {
  const lease = task.lease;
  return (
    lease.projectRoot === task.projectRoot &&
    lease.taskId === task.id &&
    lease.kind === 'coding' &&
    (task.worktreeRoot === null
      ? worktree === null
      : !!worktree &&
        worktree.state === 'ready' &&
        worktree.taskId === task.id &&
        worktree.workspaceId === task.workspaceId &&
        worktree.projectRoot === task.projectRoot &&
        worktree.baseCommit === task.baseCommit &&
        worktree.root === task.worktreeRoot &&
        worktree.lease.ownerId === lease.ownerId &&
        worktree.lease.taskId === task.id &&
        worktree.lease.projectRoot === worktree.root &&
        worktree.lease.kind === 'coding')
  );
}
