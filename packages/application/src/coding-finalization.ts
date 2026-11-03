import {
  FINALIZATION_PREVIEW_MS,
  validCodingFinalizationSelection,
  type CodingFinalizationPreview,
  type CodingFinalizationRecord,
  type CodingFinalizationResult,
} from '@runnets/domain';
import type { Clock } from './ports.js';
import type { OwnerDecision, RuntimeOwnerDecisions } from './owner-decisions.js';
import type {
  CodingFinalizationStore,
  ProjectLeaseReleasePort,
} from './coding-finalization-ports.js';
import {
  finalizationBinding,
  finalizationCurrent,
  finalizationRef,
  sameFinalizationSelection,
  selectFinalization,
  type FinalizationScope,
} from './coding-finalization-binding.js';
import { executeFinalization } from './coding-finalization-execute.js';
import { finalizationResult } from './coding-finalization-result.js';
import { recoverCodingFinalizations } from './coding-finalization-recovery.js';
const RETAINED = [
  'worktree-bytes',
  'git-administration-and-history',
  'changesets',
  'reviews',
  'evidence',
  'operations',
  'uncertainty',
  'assets',
] as const;
export interface CodingFinalizationDeps {
  readonly store: CodingFinalizationStore;
  readonly leases: ProjectLeaseReleasePort;
  readonly owner: RuntimeOwnerDecisions;
  readonly clock: Clock;
  readonly ownerId: string;
  /** Current 7.9 rebind epoch, or `null` on an original profile. */
  readonly epochId: string | null;
  readonly restored: boolean;
  readonly enabled?: boolean;
  readonly nextId: () => string;
  readonly digest: (text: string) => string;
}
/** Owner-confirmed prepared-task finalization; disable is durable before the release. */
export class CodingFinalizationService {
  readonly #d: CodingFinalizationDeps;
  readonly #scope: FinalizationScope;
  readonly #jobs = new Set<Promise<void>>();
  readonly #closing = new AbortController();
  #failure: unknown;
  #reason(error: unknown): Error {
    return error instanceof Error ? error : Error('finalization_unavailable');
  }
  constructor(deps: CodingFinalizationDeps) {
    this.#d = deps;
    this.#scope = {
      ownerId: deps.ownerId,
      epochId: deps.epochId,
      leases: deps.leases,
      digest: deps.digest,
    };
    if (!deps.restored) recoverCodingFinalizations(deps.store, deps.leases);
  }
  #refuse(record: CodingFinalizationRecord, reason: string): void {
    try {
      this.#d.store.atomic((tx) => {
        const current = tx.record(record.requestId);
        if (!current || current.state !== 'preview') return;
        tx.save(
          { ...current, revision: current.revision + 1, state: 'refused', reason },
          current.revision,
        );
      });
    } catch (error) {
      this.#failure = error;
    }
  }
  async preview(input: unknown, signal: AbortSignal): Promise<OwnerDecision> {
    if (this.#d.enabled === false) throw Error('finalization_unavailable');
    if (this.#d.restored) throw Error('finalization_restricted');
    if (this.#failure) throw this.#reason(this.#failure);
    signal.throwIfAborted();
    if (!validCodingFinalizationSelection(input)) throw Error('invalid_input');
    const i = structuredClone(input);
    const old = this.#d.store.atomic((tx) => tx.record(i.requestId));
    if (old) {
      if (!sameFinalizationSelection(old, i)) throw Error('finalization_request_conflict');
      return this.#d.owner.get(finalizationRef(old.preview.binding, old.decisionId));
    }
    const binding = this.#d.store.atomic((tx) =>
      finalizationBinding(i, selectFinalization(tx, i, this.#scope), this.#scope),
    );
    const decisionId = this.#d.nextId(),
      createdAt = this.#d.clock.now().getTime();
    if (!Number.isSafeInteger(createdAt)) throw Error('invalid_input');
    const preview: CodingFinalizationPreview = {
      binding,
      decisionId,
      createdAt,
      expiresAt: createdAt + FINALIZATION_PREVIEW_MS,
      holds: [],
      retained: [...RETAINED],
    };
    const text = JSON.stringify(preview),
      bindingDigest = this.#d.digest(text);
    if (!(await finalizationCurrent(this.#d.store, preview, bindingDigest, this.#scope)))
      throw Error('finalization_inputs_changed');
    const record: CodingFinalizationRecord = {
      requestId: i.requestId,
      taskId: i.taskId,
      projectRoot: binding.project.root,
      revision: 1,
      state: 'preview',
      decisionId,
      bindingDigest,
      preview,
      release: { state: 'not_started', outcome: null, receipt: null, detail: null },
      reason: null,
    };
    const card: OwnerDecision = {
      ...finalizationRef(binding, decisionId),
      kind: 'task-finalization',
      status: 'pending',
      version: 1,
      bindingDigest,
      createdAt,
      expiresAt: preview.expiresAt,
      previewLength: text.length,
    };
    const wait = this.#d.owner.open(
      card,
      text,
      this.#closing.signal,
      () => finalizationCurrent(this.#d.store, preview, bindingDigest, this.#scope),
      (insert) => {
        this.#d.store.atomic((tx) => {
          selectFinalization(tx, i, this.#scope);
          if (!tx.save(record, null)) throw Error('finalization_in_progress');
          insert();
        });
      },
    );
    const job = wait
      .then(async (outcome) => {
        if (outcome !== 'allowed') {
          this.#refuse(record, outcome);
          return;
        }
        await executeFinalization(
          {
            store: this.#d.store,
            leases: this.#d.leases,
            owner: this.#d.owner,
            clock: this.#d.clock,
            digest: this.#d.digest,
            scope: this.#scope,
            closing: this.#closing.signal,
          },
          record,
        );
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'finalization_outcome_unknown';
        try {
          const current = this.#d.store.atomic((tx) => tx.record(i.requestId));
          if (!current || ['finalized', 'uncertain', 'refused'].includes(current.state)) return;
          if (current.state === 'preview') this.#refuse(current, reason);
          else
            this.#d.store.atomic((tx) =>
              tx.hold({
                ...current,
                revision: current.revision + 1,
                state: 'uncertain',
                release: {
                  state: 'unproven',
                  outcome: 'thrown',
                  receipt: null,
                  detail: reason,
                },
                reason: 'release_outcome_unknown',
              }),
            );
        } catch (failure) {
          this.#failure = failure;
        }
      })
      .finally(() => this.#jobs.delete(job));
    this.#jobs.add(job);
    return card;
  }
  result(input: unknown): CodingFinalizationResult {
    if (!validCodingFinalizationSelection(input)) throw Error('invalid_input');
    const i = structuredClone(input);
    const record = this.#d.store.atomic((tx) => tx.record(i.requestId));
    if (!record) throw Error('unknown_finalization');
    if (!sameFinalizationSelection(record, i)) throw Error('finalization_request_conflict');
    const task = this.#d.store.atomic((tx) => tx.task(record.taskId));
    return finalizationResult(record, task);
  }
  async join(): Promise<void> {
    await Promise.all([...this.#jobs]);
    if (this.#failure) throw this.#reason(this.#failure);
  }
  async close(): Promise<void> {
    this.#closing.abort();
    await this.join();
  }
}
export type { CodingFinalizationStore, ProjectLeaseReleasePort };
