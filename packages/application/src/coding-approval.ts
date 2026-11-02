import {
  codingApprovalMatches,
  codingFailure,
  ok,
  type CodingApproval,
  type CodingApprovalBinding,
  type CodingResult,
} from '@runnets/domain';

export interface CodingApprovalTransaction {
  approval(id: string): CodingApproval | null;
  putApproval(value: CodingApproval): void;
}
export interface CodingApprovalStore {
  atomic<T>(work: (tx: CodingApprovalTransaction) => T): T;
}
export interface CodingApprovalOwnerPort {
  decide(preview: CodingApproval): Promise<'allow-once' | 'deny' | 'cancel'>;
}
export interface CodingApprovalDependencies {
  readonly store: CodingApprovalStore;
  readonly now: () => number;
  /** Checks current task/room/bot authority, project lease and unresolved claims. */
  readonly admit: (binding: CodingApprovalBinding) => boolean;
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
    if (!id || !preview || preview.length > 1048576 || !Number.isSafeInteger(now))
      return codingFailure('invalid_input');
    if (this.deps.restored) return codingFailure('recovery_required');
    if (!this.deps.admit(input)) return codingFailure('coding_denied');
    return this.deps.store.atomic((tx) => {
      if (tx.approval(id)) return codingFailure('request_conflict');
      const approval: CodingApproval = {
        id,
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
  ): Promise<CodingResult<CodingApproval>> {
    const binding = structuredClone(current);
    if (this.deps.restored) return codingFailure('recovery_required');
    const approval = this.deps.store.atomic((tx) => tx.approval(id));
    if (
      !approval ||
      approval.status !== 'pending' ||
      !this.deps.admit(binding) ||
      !codingApprovalMatches(
        approval.binding,
        binding,
        approval.createdAt,
        approval.expiresAt,
        this.deps.now(),
      )
    )
      return codingFailure('approval_required');
    const decision = await owner.decide(structuredClone(approval));
    return this.deps.store.atomic((tx) => {
      const pending = tx.approval(id);
      if (
        !pending ||
        pending.status !== 'pending' ||
        !this.deps.admit(binding) ||
        !codingApprovalMatches(
          pending.binding,
          binding,
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
}
