import { exactManagedBusiness } from './managed-journal-evidence.js';
import { hasManagedMarkers } from '@runnets/domain';
import { createHash } from 'node:crypto';
import {
  MANAGED_LIFETIME_RUN,
  MANAGED_LIFETIME_TOOL,
  validManagedLifetime,
  managedLifetimeFingerprint,
} from '@runnets/domain';
import {
  readToolAdmission,
  exactCodingReceipt,
  journalCodingApproval,
} from './coding-journal-receipt.js';
import type { ToolEffectRecord } from '@runnets/application';
import type { ToolEffectAdmission } from '@runnets/domain';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
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
    ...effectiveAdmission(db, row),
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

export function readEffectiveToolAdmission(
  db: DatabaseSync,
  row: Record<string, SQLOutputValue>,
): ToolEffectAdmission | undefined {
  const admission = readToolAdmission(row['admission']);
  if (!admission) return undefined;
  if (
    String(row['task_run_id']).includes('\0') ||
    String(row['tool']).includes('\0') ||
    (admission.binding &&
      typeof admission.binding === 'object' &&
      'managedLifetime' in admission.binding)
  ) {
    const r = {
      taskRunId: String(row['task_run_id']),
      attemptId: String(row['attempt_id']),
      id: String(row['id']),
      tool: String(row['tool']),
      admission,
    };
    return r.taskRunId === MANAGED_LIFETIME_RUN &&
      r.tool === MANAGED_LIFETIME_TOOL &&
      validManagedLifetime(r) &&
      createHash('sha256').update(managedLifetimeFingerprint(r)).digest('hex') ===
        row['fingerprint']
      ? admission
      : undefined;
  }
  if (hasManagedMarkers(admission))
    return exactManagedBusiness(db, row, admission) ? admission : undefined;
  const a = journalCodingApproval(db, row);
  if (a !== undefined) return a && exactCodingReceipt(a, admission) ? admission : undefined;
  const codingWorktree =
    (row['tool'] === 'coding_write' || row['tool'] === 'coding_test') &&
    admission.scope.kind === 'resources' &&
    admission.scope.resources.some((r) => r.kind === 'project-worktree');
  return codingWorktree ? undefined : admission;
}

function effectiveAdmission(db: DatabaseSync, row: Record<string, SQLOutputValue>) {
  const admission = readEffectiveToolAdmission(db, row);
  return admission ? { admission } : {};
}
