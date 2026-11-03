import { validCodingFinalizationResult } from '@runnets/domain';
import type {
  CodingFinalizationRecord,
  CodingFinalizationReleaseReceipt,
  CodingFinalizationResult,
  CodingTask,
} from '@runnets/domain';
/** Exact receipt provenance; nothing weaker may finalize a task. */
export function finalizationReceiptMatches(
  record: CodingFinalizationRecord,
  receipt: CodingFinalizationReleaseReceipt,
): boolean {
  const b = record.preview.binding;
  return (
    receipt.operationId === record.requestId &&
    receipt.bindingDigest === record.bindingDigest &&
    receipt.taskId === b.task.id &&
    receipt.workspaceId === b.task.workspaceId &&
    receipt.ownerId === b.owner.profileOwnerId &&
    receipt.projectRoot === b.project.root &&
    receipt.tokenHash === b.lease.tokenHash &&
    receipt.holderHash === b.lease.holderHash
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
