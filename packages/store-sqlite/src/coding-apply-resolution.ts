import type { DatabaseSync } from 'node:sqlite';
import type {
  CodingApplyResolutionStore,
  CodingApplyResolutionTransaction,
} from '@runnets/application';
import { SqliteCodingApplyStore } from './coding-apply-storage.js';
import { SqliteToolJournal } from './tool-journal.js';
/** The append-only decision and exact journal exclusion are the same SQLite row/commit. */
export class SqliteCodingApplyResolutionStore implements CodingApplyResolutionStore {
  readonly #applications: SqliteCodingApplyStore;
  readonly #journal: SqliteToolJournal;
  constructor(db: DatabaseSync) {
    this.#applications = new SqliteCodingApplyStore(db);
    this.#journal = new SqliteToolJournal(db);
  }
  atomic<T>(work: (tx: CodingApplyResolutionTransaction) => T): T {
    return this.#applications.atomic((tx) => {
      const resolution = (id: string) => tx.resolution?.(id) ?? null;
      return work({
        ...tx,
        unresolved: () => this.#journal.inspectPending(),
        resolution,
        putResolution: (value) => {
          const receipt = tx.application(value.applicationId),
            task = tx.task(value.taskId),
            artifact = tx.changeset(value.changesetHash);
          if (
            !receipt ||
            receipt.status !== 'uncertain' ||
            receipt.taskId !== value.taskId ||
            receipt.changesetHash !== value.changesetHash ||
            receipt.expectedBase !== value.baseCommit ||
            !task ||
            task.workspaceId !== value.workspaceId ||
            task.lease.ownerId !== value.ownerId ||
            !artifact ||
            artifact.taskId !== task.id ||
            !['before', 'after'].includes(value.accepted) ||
            value.treeHash !==
              (value.accepted === 'before' ? artifact.beforeTreeHash : artifact.afterTreeHash) ||
            !value.reason.trim() ||
            !Number.isFinite(Date.parse(value.decidedAt)) ||
            resolution(value.applicationId)
          )
            throw Error('invalid application resolution');
          this.#journal.reconcileApplyNow(
            value.applicationId,
            { taskRunId: 'apply-' + value.applicationId, attemptId: 'apply' },
            value.effectFingerprint,
            JSON.stringify(value),
          );
        },
      });
    });
  }
}
