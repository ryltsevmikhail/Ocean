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
  latestForPreset(taskId: string, presetId: string, maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw Error('changeset_limit');
    const row = this.#db
      .prepare(
        `SELECT octet_length(payload) AS bytes,
      CASE WHEN octet_length(payload)<=? THEN payload END AS payload
      FROM ocean_coding_test_evidence
      WHERE task_id=? AND json_extract(payload,'$.presetId')=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(maxBytes, taskId, presetId);
    if (!row) return null;
    if (typeof row['payload'] !== 'string' || typeof row['bytes'] !== 'number')
      throw Error('changeset_limit');
    return { bytes: row['bytes'], evidence: JSON.parse(row['payload']) as CodingTestEvidence };
  }
  list(taskId: string): readonly CodingTestEvidence[] {
    return this.#db
      .prepare('SELECT payload FROM ocean_coding_test_evidence WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((row) => JSON.parse(String(row['payload'])) as CodingTestEvidence);
  }
}
