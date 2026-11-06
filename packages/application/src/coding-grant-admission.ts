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
  roomBasis?: readonly CodingGrantDebit[],
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
  return boundCodingEffect(b, ref, projectId, roomBasis);
}
/** Historical evidence depends on the exact approved binding, independently of current readiness. */
export function boundCodingEffect(
  b: CodingApprovalBinding,
  ref: OwnerGrantReference | null,
  projectId: string,
  roomBasis?: readonly CodingGrantDebit[],
): ToolEffectAdmission {
  return {
    scope: {
      kind: 'resources',
      resources: [{ kind: 'project-worktree', projectId, worktreeId: b.taskId }],
    },
    effectKind: 'mutation',
    grantReference: ref,
    binding: {
      ...b,
      ...(roomBasis
        ? { roomBasis: roomBasis.map((item) => ({ ...item, subject: { ...item.subject } })) }
        : {}),
    },
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
  const selected = codingRoomBasis(tx, b, preview, now, claimed);
  if (selected === false || selected?.confirm) return null;
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
      (!selected ||
        selected.basis.some(
          (item) =>
            item.chargedRunId === b.runId && item.grantId === g.id && item.revision === g.revision,
        )) &&
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

import type { CodingGrantDebit, OwnerScopeGrant, OwnerPermission } from '@runnets/domain';
import type { RoomPhysicalScope } from './room-task-authority.js';
export function roomCodingPermits(
  permissions: readonly OwnerPermission[],
  action: 'project_read' | 'propose_write' | 'run_test_preset',
  resource: Extract<ToolEffectAdmission['scope'], { kind: 'resources' }>['resources'][number],
): boolean {
  return permissions.some(
    (p) =>
      p.kind === 'coding' &&
      p.actions.includes(action) &&
      p.resources.some((r) => ownerResourceIncludes(r, resource)),
  );
}
export function selectedCodingBasis(
  tx: CodingApprovalTransaction,
  scope: RoomPhysicalScope,
  action: 'project_read' | 'propose_write' | 'run_test_preset',
  resource: Extract<ToolEffectAdmission['scope'], { kind: 'resources' }>['resources'][number],
  bytes: number,
  claimed: boolean,
): { basis: CodingGrantDebit[]; confirm: boolean } | false {
  if (
    scope.reviewer ||
    !roomCodingPermits(scope.root.rootPayload.mandate.permissions, action, resource)
  )
    return false;
  const basis: CodingGrantDebit[] = [];
  let confirm = false;
  for (const issuer of scope.subjects) {
    if (!issuer.chargedRunId) return false;
    const grants = issuer.refs
      .map((ref) => tx.grants?.().find((g) => g.id === ref.grantId && g.revision === ref.revision))
      .filter(
        (g): g is OwnerScopeGrant =>
          !!g &&
          roomCodingPermits(g.permissions, action, resource) &&
          bytes <= g.limits.maxEffectBytes &&
          (tx.grantCalls?.(issuer.chargedRunId!, g.id) ?? Infinity) + (claimed ? 0 : 1) <=
            g.limits.maxCalls,
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.revision - b.revision));
    if (!grants.length) return false;
    for (const g of grants) {
      confirm ||= g.mode === 'confirm';
      basis.push({
        chargedRunId: issuer.chargedRunId,
        subject: { ...issuer.subject },
        grantId: g.id,
        revision: g.revision,
      });
    }
  }
  return { basis, confirm };
}
export function codingRoomBasis(
  tx: CodingApprovalTransaction,
  b: CodingApprovalBinding,
  preview: string,
  at: number,
  claimed = false,
): { basis: CodingGrantDebit[]; confirm: boolean } | false | null {
  const room = tx.roomScope?.(b.runId, at);
  if (!room) return room === false ? false : null;
  if (
    room.attemptId !== b.attemptId ||
    !b.invocationId.startsWith(b.attemptId + '_r' + room.ordinal + '_')
  )
    return false;
  const task = tx.task?.(b.taskId),
    worktree = tx.worktree?.(b.taskId),
    projectId = tx.projectId?.(b.projectRoot);
  if (
    !task ||
    !worktree ||
    !projectId ||
    task.devBotId !== b.botId ||
    room.root.rootPayload.mandate.codingTaskId !== task.id ||
    worktree.root !== b.worktreeRoot ||
    b.operation === 'apply'
  )
    return false;
  const action = b.operation === 'write' ? 'propose_write' : 'run_test_preset';
  if (
    !codingCapabilities(task, b).includes(action) ||
    (b.operation === 'test' &&
      !task.policy.testPresets.some(
        (p) =>
          preview.split('\n')[0] ===
          JSON.stringify({ program: p.program, args: p.args, cwd: p.cwd }),
      ))
  )
    return false;
  return selectedCodingBasis(
    tx,
    room,
    action,
    { kind: 'project-worktree', projectId, worktreeId: b.taskId },
    utf8Length(canonicalJson({ binding: b, preview })),
    claimed,
  );
}
export function codingRoomBasisMatches(
  tx: CodingApprovalTransaction,
  b: CodingApprovalBinding,
  preview: string,
  at: number,
  expected: readonly CodingGrantDebit[] | undefined,
  claimed = false,
): boolean {
  const current = codingRoomBasis(tx, b, preview, at, claimed);
  return (
    current !== false && canonicalJson(current?.basis ?? null) === canonicalJson(expected ?? null)
  );
}
