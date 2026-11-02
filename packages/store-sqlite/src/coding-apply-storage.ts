import type { DatabaseSync } from 'node:sqlite';
import type { CodingApplyStore, CodingApplyTransaction } from '@runnets/application';
import { assertCodingApplyTransition, type CodingApplyReceipt } from '@runnets/domain';
import { task as decodeTask } from './coding-store.js';
import { changesetStorage } from './changeset-storage.js';
import { SqliteCodingTestEvidenceStore } from './coding-test-evidence.js';
import { SqliteToolJournal } from './tool-journal.js';
import { withImmediateTransaction } from './transaction.js';
import type { CodingReviewVerdict } from '@runnets/domain';
export class SqliteCodingApplyStore implements CodingApplyStore {
  readonly #db: DatabaseSync;
  readonly #journal: SqliteToolJournal;
  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#journal = new SqliteToolJournal(db);
  }
  atomic<T>(work: (tx: CodingApplyTransaction) => T): T {
    const db = this.#db,
      journal = this.#journal;
    return withImmediateTransaction(db, () => {
      const application = (id: string): CodingApplyReceipt | null => {
        const row = db.prepare('SELECT payload FROM ocean_coding_applications WHERE id=?').get(id);
        return row ? (JSON.parse(String(row['payload'])) as CodingApplyReceipt) : null;
      };
      return work({
        task: (id) => decodeTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id)),
        changeset: (hash) => changesetStorage(db).changeset(hash),
        verdict: (id) => {
          const row = db
            .prepare('SELECT payload FROM ocean_coding_review_verdicts WHERE request_id=?')
            .get(id);
          return row ? (JSON.parse(String(row['payload'])) as CodingReviewVerdict) : null;
        },
        evidence: (id) => new SqliteCodingTestEvidenceStore(db).list(id),
        application,
        claimApplication: (receipt) => {
          if (
            application(receipt.id) ||
            receipt.status !== 'applying' ||
            receipt.files.some((f) => f.status !== 'pending') ||
            new Set(receipt.files.map((f) => f.path)).size !== receipt.files.length
          )
            return false;
          if (
            !journal.claimNow(
              receipt.id,
              'coding_apply',
              { taskRunId: 'apply-' + receipt.id, attemptId: 'apply' },
              JSON.stringify(receipt),
            )
          )
            return false;
          db.prepare('INSERT INTO ocean_coding_applications VALUES(?,?)').run(
            receipt.id,
            JSON.stringify(receipt),
          );
          return true;
        },
        putApplication: (receipt) => {
          const previous = application(receipt.id);
          if (!previous) throw Error('application intent missing');
          assertCodingApplyTransition(previous, receipt);
          db.prepare('UPDATE ocean_coding_applications SET payload=? WHERE id=?').run(
            JSON.stringify(receipt),
            receipt.id,
          );
          if (receipt.status !== 'applying')
            journal.settleNow(
              receipt.id,
              receipt.status === 'completed'
                ? 'completed'
                : receipt.status === 'not_started'
                  ? 'not_started'
                  : 'uncertain',
              { taskRunId: 'apply-' + receipt.id, attemptId: 'apply' },
            );
        },
      });
    });
  }
}
