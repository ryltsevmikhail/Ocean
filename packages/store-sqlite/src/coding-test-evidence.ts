import type { DatabaseSync } from 'node:sqlite';
import type { CodingTestEvidence } from '@runnets/domain';
import type { CodingTestEvidenceStore } from '@runnets/application';
export class SqliteCodingTestEvidenceStore implements CodingTestEvidenceStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  put(evidence: CodingTestEvidence): void {
    this.#db
      .prepare('INSERT INTO ocean_coding_test_evidence VALUES(?,?,?,?)')
      .run(evidence.id, evidence.hash, evidence.binding.taskId, JSON.stringify(evidence));
  }
  list(taskId: string): readonly CodingTestEvidence[] {
    return this.#db
      .prepare('SELECT payload FROM ocean_coding_test_evidence WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => JSON.parse(String(row['payload'])) as CodingTestEvidence);
  }
}
