import { task as decodeTask } from './coding-store.js';
import type { DatabaseSync } from 'node:sqlite';
import type { CodingApprovalStore, CodingApprovalTransaction } from '@runnets/application';
import {
  assertCodingApprovalTransition,
  codingApprovalClaimKey,
  type CodingApproval,
} from '@runnets/domain';
import { withImmediateTransaction } from './transaction.js';

export class SqliteCodingApprovalStore implements CodingApprovalStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  atomic<T>(work: (tx: CodingApprovalTransaction) => T): T {
    const db = this.#db;
    return withImmediateTransaction(db, () => {
      const approval = (id: string): CodingApproval | null => {
        const row = db.prepare('SELECT payload FROM ocean_coding_approvals WHERE id=?').get(id);
        if (!row) return null;
        const value = JSON.parse(String(row['payload'])) as CodingApproval;
        if (value.id !== id) throw Error('invalid approval identity');
        return value;
      };
      return work({
        task: (id) => decodeTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id)),
        approval,
        putApproval: (value) => {
          assertCodingApprovalTransition(approval(value.id), value);
          if (
            value.status === 'consumed' &&
            !db
              .prepare(
                'SELECT 1 FROM ocean_coding_approval_claims WHERE invocation_key=? AND approval_id=?',
              )
              .get(codingApprovalClaimKey(value), value.id)
          )
            throw Error('missing approval dispatch claim');
          db.prepare(
            'INSERT INTO ocean_coding_approvals VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
          ).run(value.id, JSON.stringify(value));
        },
        claimApprovalOperation: (value) => {
          const stored = approval(value.id);
          if (
            !stored ||
            stored.status !== 'allowed' ||
            JSON.stringify(stored) !== JSON.stringify(value)
          )
            return false;
          return (
            db
              .prepare('INSERT OR IGNORE INTO ocean_coding_approval_claims VALUES(?,?)')
              .run(codingApprovalClaimKey(value), value.id).changes === 1
          );
        },
      });
    });
  }
}
