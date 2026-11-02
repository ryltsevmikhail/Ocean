import type { DatabaseSync } from 'node:sqlite';
import type { CodingReviewStore, CodingReviewTransaction } from '@runnets/application';
import type { CodingReviewRequest, CodingReviewVerdict } from '@runnets/domain';
import { task as decodeTask } from './coding-store.js';
import { changesetStorage } from './changeset-storage.js';
import { withImmediateTransaction } from './transaction.js';

export class SqliteCodingReviewStore implements CodingReviewStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  atomic<T>(work: (tx: CodingReviewTransaction) => T): T {
    const db = this.#db;
    return withImmediateTransaction(db, () => {
      const request = (id: string): CodingReviewRequest | null => {
        const row = db
          .prepare('SELECT payload FROM ocean_coding_review_requests WHERE id=?')
          .get(id);
        return row ? (JSON.parse(String(row['payload'])) as CodingReviewRequest) : null;
      };
      const verdict = (id: string): CodingReviewVerdict | null => {
        const row = db
          .prepare('SELECT payload FROM ocean_coding_review_verdicts WHERE request_id=?')
          .get(id);
        return row ? (JSON.parse(String(row['payload'])) as CodingReviewVerdict) : null;
      };
      return work({
        task: (id) => decodeTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id)),
        changeset: (hash) => changesetStorage(db).changeset(hash),
        reviewRequest: request,
        reviewVerdict: verdict,
        evidenceHashes: (id) =>
          db
            .prepare('SELECT hash FROM ocean_coding_test_evidence WHERE task_id=? ORDER BY rowid')
            .all(id)
            .map((row) => String(row['hash'])),
        putReviewRequest: (value) => {
          const previous = request(value.id);
          if (previous) {
            if (
              previous.status !== 'requested' ||
              value.status !== 'completed' ||
              JSON.stringify({ ...previous, status: value.status }) !== JSON.stringify(value) ||
              !verdict(value.id)
            )
              throw Error('immutable review request');
          } else if (value.status !== 'requested')
            throw Error('review request must start requested');
          db.prepare(
            'INSERT INTO ocean_coding_review_requests VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
          ).run(value.id, JSON.stringify(value));
        },
        putReviewVerdict: (id, value) => {
          const original = request(id);
          if (
            !original ||
            original.status !== 'requested' ||
            original.reviewerBotId !== value.reviewerBotId ||
            original.reviewRoomId !== value.reviewRoomId ||
            JSON.stringify(original.binding) !== JSON.stringify(value.binding)
          )
            throw Error('review verdict binding mismatch');
          db.prepare('INSERT INTO ocean_coding_review_verdicts VALUES(?,?,?)').run(
            value.id,
            id,
            JSON.stringify(value),
          );
        },
      });
    });
  }
}
