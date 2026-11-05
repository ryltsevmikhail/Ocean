import { utf8Length } from './plugin-json.js';
import {
  canonicalJson,
  ownerResourceIncludes,
  ownerGrantApplies,
  codingCapabilities,
  type CodingApprovalBinding,
  type OwnerGrantReference,
  type ToolEffectAdmission,
} from '@runnets/domain';
import type { CodingApprovalTransaction } from './coding-approval.js';
export function codingEffectAdmission(
  tx: CodingApprovalTransaction,
  b: CodingApprovalBinding,
  ref: OwnerGrantReference | null,
): ToolEffectAdmission | undefined {
  const task = tx.task?.(b.taskId),
    worktree = tx.worktree?.(b.taskId),
    projectId = tx.projectId?.(b.projectRoot);
  if (
    !projectId ||
    !task ||
    !worktree ||
    worktree.state !== 'ready' ||
    worktree.taskId !== task.id ||
    task.projectRoot !== b.projectRoot ||
    task.worktreeRoot !== b.worktreeRoot ||
    worktree.root !== b.worktreeRoot ||
    b.operation === 'apply'
  )
    return undefined;
  return {
    scope: {
      kind: 'resources',
      resources: [{ kind: 'project-worktree', projectId, worktreeId: task.id }],
    },
    effectKind: 'mutation',
    grantReference: ref,
    binding: { ...b },
  };
}
export function codingGrant(
  tx: CodingApprovalTransaction,
  b: CodingApprovalBinding,
  preview: string,
  owner: string | undefined,
  now: number,
  reference?: OwnerGrantReference,
  claimed = false,
): OwnerGrantReference | null {
  const evidence = codingEffectAdmission(tx, b, reference ?? null),
    task = tx.task?.(b.taskId);
  if (
    !owner ||
    !tx.grants ||
    !tx.grantCalls ||
    !task ||
    !evidence ||
    evidence.scope.kind !== 'resources'
  )
    return null;
  const scope = evidence.scope.resources[0];
  if (scope?.kind !== 'project-worktree') return null;
  const action = b.operation === 'write' ? 'propose_write' : 'run_test_preset';
  if (
    !codingCapabilities(task, b).includes(action) ||
    (b.operation === 'test' &&
      !task.policy.testPresets.some(
        (p) =>
          preview.split('\n')[0] ===
          JSON.stringify({ program: p.program, args: p.args, cwd: p.cwd }),
      )) ||
    !tx.participates?.(b.workspaceId, b.roomId, b.botId)
  )
    return null;
  const bytes = utf8Length(canonicalJson({ binding: b, preview }));
  const matches = tx.grants().filter(
    (g) =>
      g.owner.ownerId === owner &&
      ownerGrantApplies(
        g,
        {
          workspaceId: b.workspaceId,
          roomId: b.roomId,
          botId: b.botId,
          taskId: b.taskId,
          projectId: scope.projectId,
        },
        now,
      ) &&
      g.permissions.some(
        (p) =>
          p.kind === 'coding' &&
          p.actions.includes(action) &&
          p.resources.some((r) => ownerResourceIncludes(r, scope)),
      ),
  );
  if (matches.some((g) => g.mode === 'confirm')) return null;
  const g = matches.find(
    (g) =>
      (!reference || (g.id === reference.grantId && g.revision === reference.revision)) &&
      bytes <= g.limits.maxEffectBytes &&
      tx.grantCalls!(b.runId, g.id) + (claimed ? 0 : 1) <= g.limits.maxCalls,
  );
  return g ? { grantId: g.id, revision: g.revision } : null;
}
