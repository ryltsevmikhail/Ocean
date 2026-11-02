import {
  codingApprovalMatches,
  validCodingApprovalBinding,
  codingFailure,
  ok,
  type CodingTask,
  type CodingWorktree,
  type CodingApproval,
  type CodingApprovalBinding,
  type CodingResult,
} from '@runnets/domain';

export interface CodingApprovalTransaction {
  worktree?(id: string): CodingWorktree | null;
  task?(id: string): CodingTask | null;
  participates?(workspaceId: string, roomId: string, botId: string): boolean;
  approval(id: string): CodingApproval | null;
  putApproval(value: CodingApproval): void;
  /** Creates the durable dispatch claim in this same transaction. */
  claimApprovalOperation(approval: CodingApproval): boolean;
}
export interface CodingApprovalStore {
  atomic<T>(work: (tx: CodingApprovalTransaction) => T): T;
}
export interface CodingApprovalOwnerPort {
  decide(
    preview: CodingApproval,
    current?: () => Promise<boolean>,
  ): Promise<'allow-once' | 'deny' | 'cancel'>;
}
export interface CodingApprovalDependencies {
  readonly authorityId?: string;
  readonly store: CodingApprovalStore;
  readonly now: () => number;
  /** Checks current task/room/bot authority, project lease and unresolved claims. */
  readonly admit: (binding: CodingApprovalBinding, tx: CodingApprovalTransaction) => boolean;
  readonly restored: boolean;
}
/** Persists preview and owner decision. Dispatch must atomically consume before effects. */
export class CodingApprovalService {
  readonly deps: CodingApprovalDependencies;
  constructor(deps: CodingApprovalDependencies) {
    this.deps = deps;
  }
  request(
    id: string,
    binding: CodingApprovalBinding,
    preview: string,
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
      if (!this.deps.admit(input, tx)) return codingFailure('coding_denied');
      if (tx.approval(id)) return codingFailure('request_conflict');
      const approval: CodingApproval = {
        id,
        ...(this.deps.authorityId ? { authorityId: this.deps.authorityId } : {}),
        binding: input,
        preview,
        createdAt: now,
        expiresAt: now + 300000,
        status: 'pending',
      };
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
    const approval = this.deps.store.atomic((tx) =>
      this.deps.admit(binding, tx) ? tx.approval(id) : null,
    );
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
          this.deps.admit(observed, tx) &&
          codingApprovalMatches(
            approval.binding,
            observed,
            approval.createdAt,
            approval.expiresAt,
            this.deps.now(),
          ),
      );
    };
    const decision = await owner.decide(structuredClone(approval), currentAtConsent);
    const observed = decision === 'allow-once' && readBinding ? await readBinding() : binding;
    return this.deps.store.atomic((tx) => {
      const pending = tx.approval(id);
      if (
        !pending ||
        pending.status !== 'pending' ||
        !this.deps.admit(observed, tx) ||
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
        status: decision === 'allow-once' ? 'allowed' : 'denied',
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
        !this.deps.admit(binding, tx) ||
        !codingApprovalMatches(
          approval.binding,
          binding,
          approval.createdAt,
          approval.expiresAt,
          this.deps.now(),
        )
      )
        return codingFailure('approval_required');
      if (!tx.claimApprovalOperation(approval)) return codingFailure('recovery_required');
      const consumed: CodingApproval = { ...approval, status: 'consumed' };
      tx.putApproval(consumed);
      return ok(consumed);
    });
  }
}
