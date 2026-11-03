import type { DatabaseSync } from 'node:sqlite';
import {
  codingApprovalClaimKey,
  type CodingApproval,
  type CodingFinalizationHold,
  type CodingTask,
} from '@runnets/domain';
import { approvalOf, digest, testClaimQuiescent } from './coding-claim-evidence.js';
import { task as decodeTask } from './coding-store.js';
function terminalTurn(db: DatabaseSync, approval: CodingApproval): boolean {
  const b = approval.binding;
  const rows = db.prepare('SELECT * FROM ocean_chat_turns WHERE task_run_id=?').all(b.runId);
  // Standalone dispatch also uses the same awaited cleanup/settlement contract.
  if (!rows.length) return true;
  if (rows.length !== 1) return false;
  const row = rows[0]!;
  const turn = JSON.parse(String(row['payload'])) as Record<string, unknown>;
  const bot = turn['bot'] as Record<string, unknown> | undefined;
  return (
    turn['id'] === row['id'] &&
    turn['status'] === row['status'] &&
    turn['workspaceId'] === row['workspace_id'] &&
    row['workspace_id'] === b.workspaceId &&
    turn['roomId'] === row['room_id'] &&
    row['room_id'] === b.roomId &&
    turn['taskRunId'] === row['task_run_id'] &&
    turn['taskRunId'] === b.runId &&
    turn['codingTaskId'] === b.taskId &&
    bot?.['id'] === b.botId &&
    bot?.['workspaceId'] === b.workspaceId &&
    ['completed', 'failed', 'cancelled'].includes(String(turn['status']))
  );
}
function quiescent(db: DatabaseSync, a: CodingApproval, task: CodingTask): boolean {
  const b = a.binding;
  if (
    b.workspaceId !== task.workspaceId ||
    b.projectRoot !== task.projectRoot ||
    b.worktreeRoot !== task.worktreeRoot ||
    b.roomId !== task.ownerRoomId ||
    b.botId !== task.devBotId ||
    b.policyVersion !== task.policyVersion ||
    !terminalTurn(db, a)
  )
    return false;
  const journal = db
    .prepare(
      `SELECT * FROM tool_invocations_v2
    WHERE id=? AND task_run_id=? AND attempt_id=?`,
    )
    .get(b.invocationId, b.runId, b.attemptId);
  if (
    !journal ||
    journal['tool'] !== 'coding_' + b.operation ||
    journal['fingerprint'] !== digest(JSON.stringify({ ...a, status: 'allowed' }))
  )
    return false;
  if (b.operation === 'test') return testClaimQuiescent(db, a, task, journal['outcome']);
  // The production filesystem adapter returns only after confirmed cgroup cleanup
  // and complete worker success. Exceptions/failed writes have no terminal proof.
  return (
    b.operation === 'write' &&
    journal['outcome'] === 'completed' &&
    !db.prepare('SELECT 1 FROM ocean_coding_test_evidence WHERE id=?').get(a.id)
  );
}
/** Historical consumed claims stay spent. Only exact, proven settlement removes a hold. */
export function codingClaimHolds(db: DatabaseSync, task: CodingTask): CodingFinalizationHold[] {
  const rows = db
    .prepare(
      `SELECT c.invocation_key,c.approval_id,a.id AS approval_row_id,a.payload
    FROM ocean_coding_approvals a LEFT JOIN ocean_coding_approval_claims c ON c.approval_id=a.id
    UNION ALL
    SELECT c.invocation_key,c.approval_id,NULL,NULL FROM ocean_coding_approval_claims c
    LEFT JOIN ocean_coding_approvals a ON a.id=c.approval_id WHERE a.id IS NULL`,
    )
    .all();
  const holds: CodingFinalizationHold[] = [];
  for (const row of rows) {
    let scope: 'global' | 'task' = 'global';
    try {
      const approval = approvalOf(row['payload']);
      if (!approval || approval.id !== row['approval_row_id']) throw Error('unproven');
      if (row['invocation_key'] === null && approval.status !== 'consumed') continue;
      if (approval.binding.taskId === task.id) scope = 'task';
      if (
        approval.status !== 'consumed' ||
        row['approval_id'] !== approval.id ||
        row['invocation_key'] !== codingApprovalClaimKey(approval)
      )
        throw Error('unproven');
      const owningTask =
        approval.binding.taskId === task.id
          ? task
          : decodeTask(
              db
                .prepare('SELECT * FROM ocean_coding_tasks WHERE id=?')
                .get(approval.binding.taskId),
            );
      if (owningTask && quiescent(db, approval, owningTask)) continue;
    } catch {
      // Malformed, unsupported or contradictory records cannot erase an effect hold.
    }
    holds.push({
      id: String(row['invocation_key'] ?? row['approval_row_id'] ?? 'unknown-claim'),
      kind: 'claim',
      outcome: 'unproven',
      scope,
    });
  }
  return holds;
}
