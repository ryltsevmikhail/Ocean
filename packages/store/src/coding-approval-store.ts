import {
  assertCodingApprovalTransition,
  codingApprovalClaimKey,
  type CodingApproval,
} from '@runnets/domain';
import type { CodingApprovalStore, CodingApprovalTransaction } from '@runnets/application';

/** Copy-on-write transactions publish approval and claim together. */
export class InMemoryCodingApprovalStore implements CodingApprovalStore {
  #approvals = new Map<string, CodingApproval>();
  #claims = new Map<string, string>();
  #active = false;
  atomic<T>(work: (tx: CodingApprovalTransaction) => T): T {
    if (this.#active) throw Error('nested approval transaction');
    this.#active = true;
    const approvals = structuredClone(this.#approvals),
      claims = new Map(this.#claims);
    try {
      const result = work({
        approval: (id) => structuredClone(approvals.get(id) ?? null),
        putApproval: (value) => {
          assertCodingApprovalTransition(approvals.get(value.id) ?? null, value);
          if (value.status === 'consumed' && claims.get(codingApprovalClaimKey(value)) !== value.id)
            throw Error('missing approval dispatch claim');
          approvals.set(value.id, structuredClone(value));
        },
        claimApprovalOperation: (value) => {
          const stored = approvals.get(value.id);
          if (
            !stored ||
            stored.status !== 'allowed' ||
            JSON.stringify(stored) !== JSON.stringify(value)
          )
            return false;
          const key = codingApprovalClaimKey(value);
          if (claims.has(key)) return false;
          claims.set(key, value.id);
          return true;
        },
      });
      const detached = structuredClone(result);
      this.#approvals = structuredClone(approvals);
      this.#claims = claims;
      return detached;
    } finally {
      this.#active = false;
    }
  }
}
