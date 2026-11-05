import type { OwnerScopeGrant } from './owner-scope-grant.js';
import type { OwnerResourceScope } from './effect-resource-scope.js';
export function ownerGrantApplies(
  g: OwnerScopeGrant,
  subject: OwnerScopeGrant['subject'],
  now: number,
): boolean {
  return (
    Number.isFinite(now) &&
    g.state === 'active' &&
    g.subject.workspaceId === subject.workspaceId &&
    g.subject.roomId === subject.roomId &&
    g.subject.botId === subject.botId &&
    (g.subject.projectId === null || g.subject.projectId === subject.projectId) &&
    (g.subject.taskId === null || g.subject.taskId === subject.taskId) &&
    now >= Date.parse(g.owner.issuedAt) &&
    (g.limits.expiresAt === null || now < Date.parse(g.limits.expiresAt))
  );
}
export function ownerResourceIncludes(
  owner: OwnerResourceScope,
  actual: OwnerResourceScope,
): boolean {
  if (owner.kind === 'project-worktree' || actual.kind === 'project-worktree')
    return (
      owner.kind === 'project-worktree' &&
      actual.kind === 'project-worktree' &&
      owner.projectId === actual.projectId &&
      (owner.worktreeId === null || owner.worktreeId === actual.worktreeId)
    );
  if (owner.connectionId !== actual.connectionId) return false;
  if (owner.kind === 'connection') return true;
  if (actual.kind === 'connection' || owner.accountId !== actual.accountId) return false;
  return (
    owner.kind === 'account' ||
    (actual.kind === 'github-repository' &&
      owner.repository.toLowerCase() === actual.repository.toLowerCase())
  );
}
