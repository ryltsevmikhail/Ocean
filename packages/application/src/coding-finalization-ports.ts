import type {
  CodingFinalizationAssets,
  CodingFinalizationHold,
  CodingFinalizationRecord,
  CodingFinalizationRegistryIdentity,
  CodingFinalizationReleaseIntent,
  CodingFinalizationReleaseReceipt,
} from '@runnets/domain';
import type { CodingTask, CodingWorktree, ProjectLease } from '@runnets/domain';
import type { ProjectLeasePort } from './coding-ports.js';
export type ProjectLeaseReleaseOutcome =
  | { readonly outcome: 'released'; readonly receipt: CodingFinalizationReleaseReceipt }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'mismatch'; readonly detail: string }
  | { readonly outcome: 'receipt_conflict'; readonly detail: string }
  | { readonly outcome: 'registry_missing'; readonly detail: string }
  | { readonly outcome: 'registry_corrupt'; readonly detail: string };
/**
 * Additive sibling of the accepted lease port. Only finalization needs the
 * durable exact-token receipt; existing reservation/cancel callers stay on the
 * unchanged boolean port.
 */
export interface ProjectLeaseReleasePort extends ProjectLeasePort {
  identity(): CodingFinalizationRegistryIdentity;
  releaseExact(
    lease: ProjectLease,
    intent: CodingFinalizationReleaseIntent,
  ): ProjectLeaseReleaseOutcome;
  releaseReceipt(operationId: string): CodingFinalizationReleaseReceipt | null;
}
export interface CodingFinalizationTransaction {
  task(id: string): CodingTask | null;
  worktree(taskId: string): CodingWorktree | null;
  participates(workspaceId: string, roomId: string, botId: string): boolean;
  assets(taskId: string): CodingFinalizationAssets;
  /** Unresolved effects/workers/claims that still touch the task or the profile. */
  holds(taskId: string): readonly CodingFinalizationHold[];
  record(requestId: string): CodingFinalizationRecord | null;
  /** The single active/finalized record for a task, if any. */
  active(taskId: string): CodingFinalizationRecord | null;
  /** Exact revision CAS for preview/refused records. */
  save(record: CodingFinalizationRecord, expectedRevision: number | null): boolean;
  /** Profile transaction: disable the exact task and persist the release intent. */
  disable(record: CodingFinalizationRecord): void;
  /** Profile publication: store the exact registry receipt and finalize the task. */
  publish(record: CodingFinalizationRecord): void;
  /** Hold an unproven release; the task stays disabled and nothing is retried. */
  hold(record: CodingFinalizationRecord): void;
}
export interface CodingFinalizationStore {
  atomic<T>(work: (tx: CodingFinalizationTransaction) => T): T;
  /** Lower interrupted previews to refused; never touches an effect. */
  recover(): void;
  unresolvedFinalizing(): readonly CodingFinalizationRecord[];
  /** Any `finalizing`/`uncertain` finalization still holds this project. */
  projectHeld(projectRoot: string): boolean;
}
export { type CodingTask, type CodingWorktree, type ProjectLease };
