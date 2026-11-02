import type {
  ToolEffectContext,
  ToolEffectOutcome,
  ToolEffectRecord,
  ToolJournalPort,
} from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/** Durable claims bind invocation identity to a run, attempt and immutable request. */
export class SqliteToolJournal implements ToolJournalPort {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS tool_invocations_v1 (
      id TEXT PRIMARY KEY, tool TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('started', 'completed', 'failed', 'uncertain'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tool_invocations_v2 (
      id TEXT NOT NULL, tool TEXT NOT NULL, task_run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN
        ('started', 'completed', 'failed', 'uncertain', 'not_started')),
      PRIMARY KEY(task_run_id, attempt_id, id)
    ) STRICT`);
  }
  /** Existing or conflicting identities never authorize a second external dispatch. */
  async claim(
    id: string,
    tool: string,
    context: ToolEffectContext,
    fingerprint: string,
  ): Promise<boolean> {
    await Promise.resolve();
    if (context.taskRunId === '' || context.attemptId === '' || fingerprint === '')
      throw new Error('tool claim requires run, attempt and request identity');
    // Legacy claims lack scope and cannot safely be assigned or replayed.
    if (this.#db.prepare('SELECT id FROM tool_invocations_v1 WHERE id = ?').get(id)) return false;
    const result = this.#db
      .prepare(
        `INSERT INTO tool_invocations_v2
      (id, tool, task_run_id, attempt_id, fingerprint, outcome)
      SELECT ?, ?, ?, ?, ?, 'started'
      WHERE NOT EXISTS (SELECT 1 FROM tool_invocations_v2
        WHERE outcome IN ('started', 'uncertain'))
      AND NOT EXISTS (SELECT 1 FROM tool_invocations_v1
        WHERE outcome IN ('started', 'uncertain'))
      ON CONFLICT DO NOTHING`,
      )
      .run(
        id,
        tool,
        context.taskRunId,
        context.attemptId,
        createHash('sha256').update(fingerprint).digest('hex'),
      );
    return result.changes === 1;
  }
  /** Only a claimed invocation can acquire its first recorded outcome. */
  async settle(
    id: string,
    outcome: Exclude<ToolEffectOutcome, 'started'>,
    context?: ToolEffectContext,
  ): Promise<void> {
    await Promise.resolve();
    if (context === undefined) throw new Error('tool effect context required');
    const result = this.#db
      .prepare(
        `UPDATE tool_invocations_v2 SET outcome = ?
      WHERE id = ? AND task_run_id = ? AND attempt_id = ? AND outcome = 'started'`,
      )
      .run(outcome, id, context.taskRunId, context.attemptId);
    if (result.changes !== 1) throw new Error('tool claim is missing or already settled');
  }
  /** Includes legacy unresolved claims globally so upgrades cannot hide uncertainty. */
  async pending(taskRunId?: string): Promise<readonly ToolEffectRecord[]> {
    await Promise.resolve();
    return this.inspectPending(taskRunId);
  }
  /** Same SQLite snapshot as the conversation acknowledgement transaction. */
  inspectPending(taskRunId?: string): readonly ToolEffectRecord[] {
    const rows =
      taskRunId === undefined
        ? this.#db
            .prepare(
              `SELECT * FROM tool_invocations_v2
          WHERE outcome IN ('started', 'uncertain')`,
            )
            .all()
        : this.#db
            .prepare(
              `SELECT * FROM tool_invocations_v2
          WHERE task_run_id = ? AND outcome IN ('started', 'uncertain')`,
            )
            .all(taskRunId);
    const records: ToolEffectRecord[] = rows.map((row) => ({
      id: String(row['id']),
      tool: String(row['tool']),
      taskRunId: String(row['task_run_id']),
      attemptId: String(row['attempt_id']),
      fingerprint: String(row['fingerprint']),
      outcome: row['outcome'] === 'started' ? 'started' : 'uncertain',
    }));
    if (taskRunId === undefined) {
      const legacy = this.#db
        .prepare(
          `SELECT id, tool, outcome FROM tool_invocations_v1
        WHERE outcome IN ('started', 'uncertain')`,
        )
        .all();
      for (const row of legacy)
        records.push({
          id: String(row['id']),
          tool: String(row['tool']),
          taskRunId: '',
          attemptId: '',
          fingerprint: '',
          outcome: row['outcome'] === 'started' ? 'started' : 'uncertain',
        });
    }
    return records;
  }
  /** A restart can only lower a started claim to uncertain; it never permits replay. */
  async recover(id: string, context: ToolEffectContext): Promise<void> {
    await Promise.resolve();
    if (context.taskRunId === '' && context.attemptId === '') {
      this.#db
        .prepare(
          `UPDATE tool_invocations_v1 SET outcome = 'uncertain'
        WHERE id = ? AND outcome = 'started'`,
        )
        .run(id);
      return;
    }
    this.#db
      .prepare(
        `UPDATE tool_invocations_v2 SET outcome = 'uncertain'
      WHERE id = ? AND task_run_id = ? AND attempt_id = ? AND outcome = 'started'`,
      )
      .run(id, context.taskRunId, context.attemptId);
  }
}
