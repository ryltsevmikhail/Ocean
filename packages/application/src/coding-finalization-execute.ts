import type {
  CodingFinalizationRecord,
  CodingFinalizationReleaseIntent,
  CodingFinalizationReleaseReceipt,
  ProjectLease,
} from '@runnets/domain';
import type { Clock } from './ports.js';
import type { RuntimeOwnerDecisions } from './owner-decisions.js';
import type {
  CodingFinalizationStore,
  ProjectLeaseReleasePort,
} from './coding-finalization-ports.js';
import { finalizationReceiptMatches, finalizationReleaseId } from './coding-finalization-result.js';
import {
  finalizationRef,
  finalizationSelectionOf,
  finalizationCurrent,
  selectFinalization,
  type FinalizationScope,
} from './coding-finalization-binding.js';
export interface FinalizationExecutionDeps {
  readonly store: CodingFinalizationStore;
  readonly leases: ProjectLeaseReleasePort;
  readonly owner: RuntimeOwnerDecisions;
  readonly clock: Clock;
  readonly digest: (text: string) => string;
  readonly scope: FinalizationScope;
  readonly closing: AbortSignal;
}
function leaseOf(record: CodingFinalizationRecord): ProjectLease {
  const b = record.preview.binding;
  return {
    ownerId: b.lease.ownerId,
    taskId: b.lease.taskId,
    requestId: b.lease.requestId,
    binding: b.lease.binding,
    kind: b.lease.kind,
    projectRoot: b.lease.projectRoot,
    token: b.lease.token,
  };
}
function intentOf(
  record: CodingFinalizationRecord,
  releasedAt: string,
): CodingFinalizationReleaseIntent {
  const b = record.preview.binding;
  return {
    operationId: finalizationReleaseId(record),
    bindingDigest: record.bindingDigest,
    taskId: b.task.id,
    workspaceId: b.task.workspaceId,
    ownerId: b.owner.profileOwnerId,
    projectRoot: b.project.root,
    tokenHash: b.lease.tokenHash,
    holderHash: b.lease.holderHash,
    releasedAt,
  };
}
/** Confirmation CAS -> durable disable/intent -> exact registry release -> publication. */
export async function executeFinalization(
  deps: FinalizationExecutionDeps,
  record: CodingFinalizationRecord,
): Promise<void> {
  const p = record.preview,
    i = finalizationSelectionOf(p.binding);
  if (!(await finalizationCurrent(deps.store, p, record.bindingDigest, deps.scope)))
    throw Error('finalization_inputs_changed');
  const confirmed = deps.store.atomic((tx) => {
    selectFinalization(tx, i, deps.scope);
    const card = deps.owner.store.find(finalizationRef(p.binding, record.decisionId));
    const now = deps.clock.now().getTime();
    if (
      !card ||
      card.status !== 'allowed' ||
      card.bindingDigest !== record.bindingDigest ||
      card.version !== 2 ||
      now < record.preview.createdAt ||
      now >= record.preview.expiresAt ||
      deps.closing.aborted
    )
      throw Error('finalization_confirmation_inactive');
    const next: CodingFinalizationRecord = {
      ...record,
      revision: record.revision + 1,
      state: 'finalizing',
      release: { state: 'pending', outcome: null, receipt: null, detail: null },
    };
    tx.disable(next);
    return next;
  });
  const receipt: CodingFinalizationReleaseReceipt | null = (() => {
    try {
      const outcome = deps.leases.releaseExact(
        leaseOf(confirmed),
        intentOf(confirmed, deps.clock.now().toISOString()),
      );
      if (outcome.outcome === 'released') return outcome.receipt;
      const release = {
        state: 'unproven' as const,
        outcome: outcome.outcome,
        receipt: null,
        detail: 'detail' in outcome ? outcome.detail : null,
      };
      deps.store.atomic((tx) =>
        tx.hold({
          ...confirmed,
          revision: confirmed.revision + 1,
          state: 'uncertain',
          release,
          reason: 'release_unproven',
        }),
      );
      return null;
    } catch (error) {
      deps.store.atomic((tx) =>
        tx.hold({
          ...confirmed,
          revision: confirmed.revision + 1,
          state: 'uncertain',
          release: {
            state: 'unproven',
            outcome: 'thrown',
            receipt: null,
            detail: error instanceof Error ? error.message : 'release_threw',
          },
          reason: 'release_outcome_unknown',
        }),
      );
      return null;
    }
  })();
  if (!receipt) return;
  if (!finalizationReceiptMatches(confirmed, receipt)) throw Error('finalization_receipt_conflict');
  deps.store.atomic((tx) =>
    tx.publish({
      ...confirmed,
      revision: confirmed.revision + 1,
      state: 'finalized',
      release: { state: 'released', outcome: 'released', receipt, detail: null },
    }),
  );
}
