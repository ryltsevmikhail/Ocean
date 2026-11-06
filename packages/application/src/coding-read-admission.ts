import type { CodingApprovalDependencies } from './coding-approval.js';
import type { CodingApprovalOwnerPort } from './coding-approval.js';
import {
  canonicalJson,
  validConversationText,
  type CodingGrantDebit,
  type ServiceJson,
  type ToolEffectAdmission,
} from '@runnets/domain';
import type { CodingApprovalTransaction } from './coding-approval.js';
import { selectedCodingBasis } from './coding-grant-admission.js';
export interface CodingReadRequest {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly taskId: string;
  readonly projectRoot: string;
  readonly worktreeRoot: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly tool: 'read_file' | 'list_files';
  readonly arguments: ServiceJson;
  readonly operationDigest: string;
}
export interface CodingReadPreview {
  readonly request: CodingReadRequest;
  readonly effect: ToolEffectAdmission;
  readonly limits: readonly {
    readonly chargedRunId: string;
    readonly grantId: string;
    readonly revision: number;
    readonly maxCalls: number;
    readonly maxEffectBytes: number;
    readonly expiresAt: string | null;
  }[];
}
export interface CodingReadPrepared {
  readonly preview: CodingReadPreview;
  readonly confirmationRequired: boolean;
}
export function codingReadAdmission(
  tx: CodingApprovalTransaction,
  r: CodingReadRequest,
  at: number,
  claimed = false,
): CodingReadPrepared | null {
  if (
    !tx.projectId ||
    !tx.grants ||
    !tx.grantCalls ||
    !r ||
    !Object.keys(r).every((k) =>
      [
        'workspaceId',
        'roomId',
        'botId',
        'taskId',
        'projectRoot',
        'worktreeRoot',
        'runId',
        'attemptId',
        'invocationId',
        'tool',
        'arguments',
        'operationDigest',
      ].includes(k),
    ) ||
    ![r.workspaceId, r.roomId, r.botId, r.taskId, r.runId, r.attemptId, r.invocationId].every(
      (id) => validConversationText(id, 512),
    ) ||
    !['read_file', 'list_files'].includes(r.tool) ||
    !r.arguments ||
    typeof r.arguments !== 'object' ||
    Array.isArray(r.arguments)
  )
    return null;
  const args = r.arguments;
  if (
    !('path' in args) ||
    typeof args.path !== 'string' ||
    !validConversationText(args.path, 1024) ||
    Object.keys(args).some(
      (k) => !['path', ...(r.tool === 'read_file' ? ['start_line', 'end_line'] : [])].includes(k),
    ) ||
    ['start_line', 'end_line'].some(
      (k) =>
        k in args && (typeof args[k] !== 'number' || !Number.isSafeInteger(args[k]) || args[k] < 1),
    ) ||
    r.operationDigest !== tx.projectId(canonicalJson([r.tool, r.arguments]))
  )
    return null;
  const scope = tx.roomScope?.(r.runId, at),
    task = tx.task?.(r.taskId),
    worktree = tx.worktree?.(r.taskId);
  if (
    !scope ||
    scope.attemptId !== r.attemptId ||
    !r.invocationId.startsWith(r.attemptId + '_r' + scope.ordinal + '_') ||
    scope.reviewer ||
    !task ||
    !worktree ||
    task.status !== 'reserved' ||
    task.devBotId !== r.botId ||
    task.ownerRoomId !== r.roomId ||
    task.workspaceId !== r.workspaceId ||
    task.projectRoot !== r.projectRoot ||
    task.worktreeRoot !== r.worktreeRoot ||
    worktree.state !== 'ready' ||
    worktree.root !== r.worktreeRoot ||
    scope.root.rootPayload.mandate.codingTaskId !== task.id ||
    !task.policy.devCapabilities.includes('project_read')
  )
    return null;
  const projectId = tx.projectId(r.projectRoot),
    resource = { kind: 'project-worktree' as const, projectId, worktreeId: task.id };
  const selected = selectedCodingBasis(
    tx,
    scope,
    'project_read',
    resource,
    new TextEncoder().encode(canonicalJson(r)).length,
    claimed,
  );
  if (!selected) return null;
  const basis = selected.basis.map((d) => ({ ...d, subject: { ...d.subject } }));
  const effect: ToolEffectAdmission = {
    scope: { kind: 'resources', resources: [resource] },
    effectKind: 'observation',
    grantReference: basis[0] ? { grantId: basis[0].grantId, revision: basis[0].revision } : null,
    binding: { ...r, roomBasis: basis },
  };
  return {
    confirmationRequired: selected.confirm,
    preview: {
      request: structuredClone(r),
      effect,
      limits: basis.map((d) => {
        const g = tx.grants!().find((g) => g.id === d.grantId)!;
        return {
          chargedRunId: d.chargedRunId,
          grantId: d.grantId,
          revision: d.revision,
          ...g.limits,
        };
      }),
    },
  };
}
export function sameCodingRead(a: CodingReadPrepared, b: CodingReadPrepared): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
export type { CodingGrantDebit };

export async function claimCodingRead(
  deps: CodingApprovalDependencies,
  request: CodingReadRequest,
  owner: CodingApprovalOwnerPort,
  signal: AbortSignal,
  live: () => Promise<boolean>,
) {
  const r = structuredClone(request),
    at = () => deps.now();
  const initial = deps.store.atomic((tx) => codingReadAdmission(tx, r, at()));
  if (!initial || deps.restored || signal.aborted) return null;
  const current = async () =>
    !signal.aborted &&
    (await live()) &&
    deps.store.atomic((tx) => {
      const p = codingReadAdmission(tx, r, at());
      return !!p && sameCodingRead(initial, p);
    });
  if (
    initial.confirmationRequired &&
    (!owner.decideRead || (await owner.decideRead(initial.preview, current)) !== 'allow-once')
  )
    return null;
  if (!(await current())) return null;
  const admission = initial.preview.effect;
  const claimed = deps.store.atomic((tx) => {
    const p = codingReadAdmission(tx, r, at());
    return !!p && sameCodingRead(initial, p) && tx.claimRead?.(r, admission, at()) === true;
  });
  if (!claimed) return null;
  let closed = false;
  return {
    authorize: () =>
      !closed &&
      !signal.aborted &&
      deps.store.atomic((tx) => tx.readClaimed?.(r, admission, at()) === true),
    settle: (outcome: 'completed' | 'failed' | 'uncertain' | 'not_started') => {
      if (closed) throw Error('read claim closed');
      deps.store.atomic((tx) => {
        if (!tx.settleRead) throw Error('read settlement unavailable');
        tx.settleRead(r, outcome);
      });
      closed = true;
    },
  };
}
