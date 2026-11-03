import {
  ok,
  codingFailure,
  projectRootsOverlap,
  validCodingFinalizationReleaseReceipt,
  type CodingFinalizationRegistryIdentity,
  type CodingFinalizationReleaseIntent,
  type CodingFinalizationReleaseReceipt,
  type ProjectLease,
  type ProjectLeaseHolder,
  type CodingResult,
} from '@runnets/domain';
import type { ProjectLeaseReleasePort } from '@runnets/application';
const IDENTITY: CodingFinalizationRegistryIdentity = {
  path: '/in-memory/project-leases',
  schema: 'project_leases_v1+project_lease_receipts_v1',
};
/** Share one instance across profiles to model the per-user durable registry. */
export class InMemoryProjectLeases implements ProjectLeaseReleasePort {
  #entries = new Map<string, ProjectLease>();
  #receipts = new Map<string, CodingFinalizationReleaseReceipt>();
  #sequence = 0;
  identity(): CodingFinalizationRegistryIdentity {
    return IDENTITY;
  }
  acquire(projectRoot: string, holder: ProjectLeaseHolder): CodingResult<ProjectLease> {
    for (const lease of this.#entries.values()) {
      if (
        JSON.stringify([
          lease.projectRoot,
          lease.ownerId,
          lease.taskId,
          lease.requestId,
          lease.binding,
          lease.kind,
        ]) ===
        JSON.stringify([
          projectRoot,
          holder.ownerId,
          holder.taskId,
          holder.requestId,
          holder.binding,
          holder.kind,
        ])
      )
        return ok(structuredClone(lease));
      if (projectRootsOverlap(projectRoot, lease.projectRoot)) return codingFailure('project_busy');
    }
    const lease = { ...holder, projectRoot, token: 'lease-' + String(++this.#sequence) };
    this.#entries.set(lease.token, structuredClone(lease));
    return ok(lease);
  }
  owns(lease: ProjectLease): boolean {
    return JSON.stringify(this.#entries.get(lease.token)) === JSON.stringify(lease);
  }
  release(lease: ProjectLease): boolean {
    if (!this.#entries.has(lease.token)) return true;
    if (!this.owns(lease)) return false;
    return this.#entries.delete(lease.token);
  }
  releaseExact(
    lease: ProjectLease,
    intent: CodingFinalizationReleaseIntent,
  ): ReturnType<ProjectLeaseReleasePort['releaseExact']> {
    const existing = this.#receipts.get(intent.operationId);
    if (existing)
      return existing.bindingDigest === intent.bindingDigest &&
        existing.tokenHash === intent.tokenHash &&
        existing.holderHash === intent.holderHash
        ? { outcome: 'released', receipt: existing }
        : { outcome: 'receipt_conflict', detail: 'operation_receipt_mismatch' };
    const current = this.#entries.get(lease.token);
    if (!current) return { outcome: 'absent' };
    if (!this.owns(lease)) return { outcome: 'mismatch', detail: 'holder_changed' };
    const receipt: CodingFinalizationReleaseReceipt = { version: 1, ...intent, registry: IDENTITY };
    if (!validCodingFinalizationReleaseReceipt(receipt)) throw Error('invalid_receipt');
    // Store package tests use only synthetic digests; hashes stay in the receipt payload.
    this.#receipts.set(intent.operationId, receipt);
    this.#entries.delete(lease.token);
    return { outcome: 'released', receipt };
  }
  releaseReceipt(operationId: string): CodingFinalizationReleaseReceipt | null {
    return this.#receipts.get(operationId) ?? null;
  }
}
