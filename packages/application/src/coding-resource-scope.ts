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

/** Before inspecting any requested path, every held selector needs supported canonical facts. */
export function qualifiedCodingResourceFootprint(admission?: ToolEffectAdmission): boolean {
  if (!validToolEffectAdmission(admission) || admission.scope.kind !== 'resources') return false;
  const binding = admission.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const facts = binding as Readonly<Record<string, unknown>>;
  return (
    typeof facts['projectRoot'] === 'string' &&
    canonicalRoot(facts['projectRoot']) &&
    admission.scope.resources.every(
      (r) =>
        r.kind === 'project-worktree' &&
        (r.worktreeId === null ||
          (typeof facts['worktreeRoot'] === 'string' && canonicalRoot(facts['worktreeRoot']))),
    )
  );
}
