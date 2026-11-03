import { validCodingFinalizationResult } from '@runnets/domain';
import type {
  CodingFinalizationRecord,
  CodingFinalizationReleaseReceipt,
  CodingFinalizationResult,
  CodingTask,
} from '@runnets/domain';
/** Global registry identity derives only from the already durable exact preview. */
export function finalizationReleaseId(
  record: Pick<CodingFinalizationRecord, 'bindingDigest'>,
): string {
  return 'ocean-finalize-v2-' + record.bindingDigest;
}
/** Exact receipt provenance; legacy ids are accepted only by read-only recovery. */
export function finalizationReceiptMatches(
  record: CodingFinalizationRecord,
  receipt: CodingFinalizationReleaseReceipt,
  legacy = false,
): boolean {
  const b = record.preview.binding;
  return (
    receipt.operationId === (legacy ? record.requestId : finalizationReleaseId(record)) &&
    receipt.bindingDigest === record.bindingDigest &&
    receipt.taskId === b.task.id &&
    receipt.workspaceId === b.task.workspaceId &&
    receipt.ownerId === b.owner.profileOwnerId &&
    receipt.projectRoot === b.project.root &&
    receipt.tokenHash === b.lease.tokenHash &&
    receipt.holderHash === b.lease.holderHash &&
    receipt.registry.path === b.lease.registry.path &&
    receipt.registry.schema === b.lease.registry.schema
  );
}
export function finalizationResult(
  record: CodingFinalizationRecord,
  task: CodingTask | null,
): CodingFinalizationResult {
  if (!task) throw Error('finalization_scope_conflict');
  const b = record.preview.binding;
  const result: CodingFinalizationResult = {
    workspaceId: b.task.workspaceId,
    roomId: b.task.ownerRoomId,
    requestId: record.requestId,
    taskId: record.taskId,
    state: record.state,
    reason: record.reason,
    bindingDigest: record.bindingDigest,
    taskStatus: task.status,
    release: structuredClone(record.release),
    retained: {
      projectRoot: b.project.root,
      baseCommit: b.project.baseCommit,
      worktreeRoot: b.project.worktreeRoot,
      policyVersion: 1,
      policyDigest: b.policy.digest,
      changesets: [...b.assets.changesets],
      reviews: [...b.assets.reviews],
      evidence: [...b.assets.evidence],
    },
  };
  if (!validCodingFinalizationResult(result)) throw Error('invalid_finalization_state');
  return structuredClone(result);
}
