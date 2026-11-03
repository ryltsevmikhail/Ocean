import type { CodingFinalizationReleaseReceipt } from '@runnets/domain';
import type {
  CodingFinalizationStore,
  ProjectLeaseReleasePort,
} from './coding-finalization-ports.js';
import { finalizationReceiptMatches, finalizationReleaseId } from './coding-finalization-result.js';
/**
 * Startup only narrows uncertainty. A matching durable registry receipt
 * publishes `finalized`; anything else is held `uncertain` and is never
 * retried, reported as cancelled, or inferred from a process having exited.
 */
export function recoverCodingFinalizations(
  store: CodingFinalizationStore,
  leases: ProjectLeaseReleasePort,
): void {
  store.recover();
  for (const record of store.unresolvedFinalizing()) {
    let receipt: CodingFinalizationReleaseReceipt | null = null;
    let legacy = false;
    try {
      receipt = leases.releaseReceipt(finalizationReleaseId(record));
      // Old intents used a profile-local request id. Read it only when the new
      // identity is absent; never bypass contradictory/corrupt scoped evidence.
      if (!receipt) {
        receipt = leases.releaseReceipt(record.requestId);
        legacy = true;
      }
    } catch {
      receipt = null;
    }
    if (receipt && finalizationReceiptMatches(record, receipt, legacy)) {
      store.atomic((tx) =>
        tx.publish({
          ...record,
          revision: record.revision + 1,
          state: 'finalized',
          release: { state: 'released', outcome: 'released', receipt, detail: null },
        }),
      );
    } else {
      store.atomic((tx) =>
        tx.hold({
          ...record,
          revision: record.revision + 1,
          state: 'uncertain',
          release: {
            state: 'unproven',
            outcome: null,
            receipt: null,
            detail: 'release_receipt_unproven',
          },
          reason: 'release_outcome_unknown',
        }),
      );
    }
  }
}
