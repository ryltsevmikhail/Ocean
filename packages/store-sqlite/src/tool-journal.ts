import { journalCodingApproval } from './coding-journal-receipt.js';
import {
  effectResourcesConflict,
  validToolEffectAdmission,
  type ToolEffectAdmission,
} from '@runnets/domain';
import { withImmediateTransaction } from './transaction.js';
import { admissionColumn } from './tool-admission-schema.js';
import { inspectPendingEffects } from './tool-journal-reads.js';
import { createEffectResolutions } from './tool-effect-resolution.js';
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
      ${admissionColumn},
      PRIMARY KEY(task_run_id, attempt_id, id)
    ) STRICT`);
    createEffectResolutions(db);
  }
  /** Existing or conflicting identities never authorize a second external dispatch. */
  async claim(
    id: string,
    tool: string,
    context: ToolEffectContext,
    fingerprint: string,
    admission?: ToolEffectAdmission,
  ): Promise<boolean> {
    await Promise.resolve();
    return this.claimNow(id, tool, context, fingerprint, admission);
  }
  /** Synchronous admission for callers already inside the store transaction. */
  claimNow(
    id: string,
    tool: string,
    context: ToolEffectContext,
    fingerprint: string,
    admission?: ToolEffectAdmission,
  ): boolean {
    if (!context.taskRunId || !context.attemptId || !fingerprint)
      throw Error('tool claim requires run, attempt and request identity');
    if (admission !== undefined && !validToolEffectAdmission(admission))
      throw Error('invalid tool effect admission');
    const insert = () => {
      if (
        this.#db.prepare('SELECT id FROM tool_invocations_v1 WHERE id=?').get(id) ||
        this.inspectConflicts(admission).length
      )
        return false;
      return (
        this.#db
          .prepare(
            `INSERT INTO tool_invocations_v2(id,tool,task_run_id,attempt_id,fingerprint,outcome,admission)
        VALUES(?,?,?,?,?,'started',?) ON CONFLICT DO NOTHING`,
          )
          .run(
            id,
            tool,
            context.taskRunId,
            context.attemptId,
            createHash('sha256').update(fingerprint).digest('hex'),
            admission ? JSON.stringify(admission) : null,
          ).changes === 1
      );
    };
    return this.#db.isTransaction ? insert() : withImmediateTransaction(this.#db, insert);
  }
  grantCalls(run: string, id: string): number {
    const rows = this.#db
      .prepare(
        `SELECT id,tool,task_run_id,attempt_id,fingerprint,json_extract(admission,'$.grantReference.grantId') AS grant_id
        FROM tool_invocations_v2 WHERE task_run_id=? AND (json_extract(admission,'$.grantReference.grantId')=? OR tool IN ('coding_write','coding_test'))`,
      )
      .all(run, id);
    return rows.filter((row) => {
      const approval = journalCodingApproval(this.#db, row);
      return approval ? approval.grantReference?.grantId === id : row['grant_id'] === id;
    }).length;
  }
  inspectConflicts(admission?: ToolEffectAdmission): readonly ToolEffectRecord[] {
    return this.inspectPending().filter((r) => effectResourcesConflict(r.admission, admission));
  }
  conflicts(admission?: ToolEffectAdmission): Promise<readonly ToolEffectRecord[]> {
    return Promise.resolve(this.inspectConflicts(admission));
  }
  /** Only a claimed invocation can acquire its first recorded outcome. */
  async settle(
    id: string,
    outcome: Exclude<ToolEffectOutcome, 'started'>,
    context?: ToolEffectContext,
  ): Promise<void> {
    await Promise.resolve();
    this.settleNow(id, outcome, context);
  }
  settleNow(
    id: string,
    outcome: Exclude<ToolEffectOutcome, 'started'>,
    context?: ToolEffectContext,
  ): void {
    if (context === undefined) throw new Error('tool effect context required');
    const result = this.#db
      .prepare(
        `UPDATE tool_invocations_v2 SET outcome = ?
      WHERE id = ? AND task_run_id = ? AND attempt_id = ? AND outcome = 'started'`,
      )
      .run(outcome, id, context.taskRunId, context.attemptId);
    if (result.changes !== 1) throw new Error('tool claim is missing or already settled');
  }
  /** Transaction-local recovery can retain an existing hold, never upgrade its outcome. */
  holdNow(id: string, context: ToolEffectContext): void {
    const row = this.#db
      .prepare(
        'SELECT outcome FROM tool_invocations_v2 WHERE id=? AND task_run_id=? AND attempt_id=?',
      )
      .get(id, context.taskRunId, context.attemptId);
    if (row?.['outcome'] === 'uncertain') return;
    this.settleNow(id, 'uncertain', context);
  }
  /** Called only inside the owner's durable reconciliation transaction; never rewrites history. */
  reconcileApplyNow(
    id: string,
    context: ToolEffectContext,
    fingerprint: string,
    payload: string,
  ): void {
    if (context.taskRunId !== 'apply-' + id || context.attemptId !== 'apply')
      throw Error('invalid apply effect context');
    const result = this.#db
      .prepare(
        `INSERT INTO tool_effect_resolutions_v1
      SELECT id,task_run_id,attempt_id,fingerprint,? FROM tool_invocations_v2
      WHERE id=? AND task_run_id=? AND attempt_id=? AND fingerprint=? AND tool='coding_apply' AND outcome='uncertain'`,
      )
      .run(payload, id, context.taskRunId, context.attemptId, fingerprint);
    if (result.changes !== 1) throw Error('unresolved apply effect missing');
  }
  /**
   * Owner acknowledgement of one uncertain service-plugin operation: records an
   * exact resolution so the global unknown-effect hold is released while the
   * original `uncertain` outcome and every replay protection stay intact.
   * Never claims remote certainty and never authorizes a retry.
   */
  resolveUncertainNow(id: string, context: ToolEffectContext, tool: string, payload: string): void {
    if (tool.length === 0) throw Error('plugin operation tool required');
    const result = this.#db
      .prepare(
        `INSERT INTO tool_effect_resolutions_v1
      SELECT id,task_run_id,attempt_id,fingerprint,? FROM tool_invocations_v2
      WHERE id=? AND task_run_id=? AND attempt_id=? AND tool=? AND outcome='uncertain'`,
      )
      .run(payload, id, context.taskRunId, context.attemptId, tool);
    if (result.changes !== 1) throw Error('uncertain plugin effect is missing');
  }
  /** Includes legacy unresolved claims globally so upgrades cannot hide uncertainty. */
  async pending(taskRunId?: string): Promise<readonly ToolEffectRecord[]> {
    await Promise.resolve();
    return this.inspectPending(taskRunId);
  }
  /** Same SQLite snapshot as the conversation acknowledgement transaction. */
  inspectPending(taskRunId?: string): readonly ToolEffectRecord[] {
    return inspectPendingEffects(this.#db, taskRunId);
  }

  /** A restart can only lower a started claim to uncertain; it never permits replay. */
  async recover(id: string, context: ToolEffectContext): Promise<void> {
    await Promise.resolve();
    this.recoverNow(id, context);
  }
  /** Synchronous recovery used inside an owner transaction; never permits replay. */
  recoverNow(id: string, context: ToolEffectContext): void {
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
