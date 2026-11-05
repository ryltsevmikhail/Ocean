import type { ToolEffectRecord } from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { unresolvedEffectSql } from './tool-effect-resolution.js';

/** Canonical pending journal inspector, also usable under the conversation write transaction. */
export function inspectPendingEffects(
  db: DatabaseSync,
  taskRunId?: string,
): readonly ToolEffectRecord[] {
  const rows =
    taskRunId === undefined
      ? db.prepare(`SELECT e.* FROM tool_invocations_v2 e WHERE ${unresolvedEffectSql('e')}`).all()
      : db
          .prepare(
            `SELECT e.* FROM tool_invocations_v2 e WHERE e.task_run_id = ? AND ${unresolvedEffectSql('e')}`,
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
    const legacy = db
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
