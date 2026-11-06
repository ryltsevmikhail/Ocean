import type { RoomPhysicalScope } from './room-task-authority.js';
import {
  claimCodingRead,
  type CodingReadRequest,
  type CodingReadPreview,
} from './coding-read-admission.js';
import { type ToolEffectAdmission } from '@runnets/domain';
import { codingGrant, codingRoomBasis, codingRoomBasisMatches } from './coding-grant-admission.js';
import {
  codingApprovalMatches,
  validCodingApprovalBinding,
  codingFailure,
  ok,
  type OwnerScopeGrant,
  type CodingTask,
  type CodingWorktree,
  type CodingApproval,
  type CodingApprovalBinding,
  type CodingResult,
} from '@runnets/domain';

export interface CodingApprovalTransaction {
  claimRead?(request: CodingReadRequest, admission: ToolEffectAdmission, at: number): boolean;
  readClaimed?(request: CodingReadRequest, admission: ToolEffectAdmission, at: number): boolean;
  settleRead?(
    request: CodingReadRequest,
    outcome: 'completed' | 'failed' | 'uncertain' | 'not_started',
  ): void;
  roomScope?(runId: string, at: number, selection?: true): RoomPhysicalScope | false | null;
  projectId?(root: string): string;
  grants?(): readonly OwnerScopeGrant[];
  grantCalls?(run: string, id: string): number;
  claimed?(value: CodingApproval, at?: number): boolean;
  worktree?(id: string): CodingWorktree | null;
  task?(id: string): CodingTask | null;
  participates?(workspaceId: string, roomId: string, botId: string): boolean;
  approval(id: string): CodingApproval | null;
  putApproval(value: CodingApproval): void;
  /** Creates the durable dispatch claim in this same transaction. */
  claimApprovalOperation(approval: CodingApproval, at?: number): boolean;
}
export interface CodingApprovalStore {
  atomic<T>(work: (tx: CodingApprovalTransaction) => T): T;
}
export interface CodingApprovalOwnerPort {
  decideRead?(
    preview: CodingReadPreview,
    current: () => Promise<boolean>,
  ): Promise<'allow-once' | 'deny' | 'cancel'>;
  decide(
    preview: CodingApproval,
    current?: () => Promise<boolean>,
  ): Promise<'allow-once' | 'deny' | 'cancel'>;
}
export interface CodingApprovalDependencies {
  readonly authorityId?: string;
  readonly grantOwnerId?: string;
  readonly store: CodingApprovalStore;
  readonly now: () => number;
  /** Checks current task/room/bot authority, project lease and unresolved claims. */
  readonly admit: (
    binding: CodingApprovalBinding,
    tx: CodingApprovalTransaction,
    approval?: CodingApproval,
  ) => boolean;
  readonly restored: boolean;
}
/** Persists preview and owner decision. Dispatch must atomically consume before effects. */
export class CodingApprovalService {
  readonly deps: CodingApprovalDependencies;
  constructor(deps: CodingApprovalDependencies) {
    this.deps = deps;
  }
  claimRead(
    request: CodingReadRequest,
    owner: CodingApprovalOwnerPort,
    signal: AbortSignal,
    live: () => Promise<boolean>,
  ) {
    return claimCodingRead(this.deps, request, owner, signal, live);
  }
  request(
    id: string,
    binding: CodingApprovalBinding,
    preview: string,
    guarded = false,
  ): CodingResult<CodingApproval> {
    const input = structuredClone(binding);
    const now = this.deps.now();
    if (
      !id ||
      !preview ||
      preview.length > 1048576 ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(now + 300000) ||
      !validCodingApprovalBinding(input)
    )
      return codingFailure('invalid_input');
    if (this.deps.restored) return codingFailure('recovery_required');
    return this.deps.store.atomic((tx) => {
      const ref = guarded ? codingGrant(tx, input, preview, this.deps.grantOwnerId, now) : null;
      const roomBasis = codingRoomBasis(tx, input, preview, now);
      if (roomBasis === false || (roomBasis && !guarded)) return codingFailure('coding_denied');
      const approval: CodingApproval = {
        ...(roomBasis ? { roomBasis: roomBasis.basis } : {}),
        ...(guarded ? { guardedDispatch: true as const } : {}),
        ...(ref ? { grantReference: ref } : {}),
        id,
        ...(this.deps.authorityId ? { authorityId: this.deps.authorityId } : {}),
        binding: input,
        preview,
        createdAt: now,
        expiresAt: now + 300000,
        status: 'pending',
      };
      if (!this.deps.admit(input, tx, approval)) return codingFailure('coding_denied');
      if (tx.approval(id)) return codingFailure('request_conflict');
      tx.putApproval(approval);
      return ok(approval);
    });
  }
  async decide(
    id: string,
    current: CodingApprovalBinding,
    owner: CodingApprovalOwnerPort,
    readBinding?: () => Promise<CodingApprovalBinding>,
  ): Promise<CodingResult<CodingApproval>> {
    const binding = structuredClone(current);
    if (this.deps.restored) return codingFailure('recovery_required');
    const approval = this.deps.store.atomic((tx) => {
      const a = tx.approval(id);
      return a && this.deps.admit(binding, tx, a) ? a : null;
    });
    if (
      !approval ||
      approval.authorityId !== this.deps.authorityId ||
      approval.status !== 'pending' ||
      !codingApprovalMatches(
        approval.binding,
        binding,
        approval.createdAt,
        approval.expiresAt,
        this.deps.now(),
      )
    )
      return codingFailure('approval_required');
    const currentAtConsent = async () => {
      const observed = readBinding ? await readBinding() : binding;
      return this.deps.store.atomic(
        (tx) =>
          tx.approval(id)?.status === 'pending' &&
          this.deps.admit(observed, tx, approval) &&
          codingApprovalMatches(
            approval.binding,
            observed,
            approval.createdAt,
            approval.expiresAt,
            this.deps.now(),
          ),
      );
    };
    const allowed =
      approval.grantReference !== undefined ||
      (await owner.decide(structuredClone(approval), currentAtConsent)) === 'allow-once';
    const observed = allowed && readBinding ? await readBinding() : binding;
    return this.deps.store.atomic((tx) => {
      const pending = tx.approval(id);
      if (
        !pending ||
        pending.status !== 'pending' ||
        !this.deps.admit(observed, tx, pending) ||
        (pending.grantReference &&
          !codingGrant(
            tx,
            observed,
            pending.preview,
            this.deps.grantOwnerId,
            this.deps.now(),
            pending.grantReference,
          )) ||
        !codingApprovalMatches(
          pending.binding,
          observed,
          pending.createdAt,
          pending.expiresAt,
          this.deps.now(),
        )
      )
        return codingFailure('approval_required');
      const value: CodingApproval = {
        ...pending,
        status: allowed ? 'allowed' : 'denied',
      };
      tx.putApproval(value);
      return ok(value);
    });
  }
  consume(id: string, current: CodingApprovalBinding): CodingResult<CodingApproval> {
    const binding = structuredClone(current);
    if (this.deps.restored) return codingFailure('recovery_required');
    return this.deps.store.atomic((tx) => {
      const approval = tx.approval(id);
      if (
        !approval ||
        approval.authorityId !== this.deps.authorityId ||
        approval.status !== 'allowed' ||
        (approval.grantReference &&
          !codingGrant(
            tx,
            binding,
            approval.preview,
            this.deps.grantOwnerId,
            this.deps.now(),
            approval.grantReference,
          )) ||
        !this.deps.admit(binding, tx, approval) ||
        !codingRoomBasisMatches(
          tx,
          binding,
          approval.preview,
          this.deps.now(),
          approval.roomBasis,
        ) ||
        !codingApprovalMatches(
          approval.binding,
          binding,
          approval.createdAt,
          approval.expiresAt,
          this.deps.now(),
        )
      )
        return codingFailure('approval_required');
      if (!tx.claimApprovalOperation(approval, this.deps.now()))
        return codingFailure('recovery_required');
      const consumed: CodingApproval = { ...approval, status: 'consumed' };
      tx.putApproval(consumed);
      return ok(consumed);
    });
  }
  authorizeDispatch(id: string, binding: CodingApprovalBinding): boolean {
    if (this.deps.restored) return false;
    return this.deps.store.atomic((tx) => {
      const a = tx.approval(id);
      return (
        !!a &&
        a.status === 'consumed' &&
        a.guardedDispatch === true &&
        a.authorityId === this.deps.authorityId &&
        tx.claimed?.(a, this.deps.now()) === true &&
        this.deps.admit(binding, tx, a) &&
        codingRoomBasisMatches(tx, binding, a.preview, this.deps.now(), a.roomBasis, true) &&
        codingApprovalMatches(a.binding, binding, a.createdAt, a.expiresAt, this.deps.now()) &&
        (!a.grantReference ||
          !!codingGrant(
            tx,
            binding,
            a.preview,
            this.deps.grantOwnerId,
            this.deps.now(),
            a.grantReference,
            true,
          ))
      );
    });
  }
}
