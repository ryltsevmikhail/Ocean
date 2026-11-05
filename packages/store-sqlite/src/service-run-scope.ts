import { task as readTask } from './coding-store.js';
import type { DatabaseSync } from 'node:sqlite';
import type { ServiceCallRequest } from '@runnets/application';
import { createHash } from 'node:crypto';
export const codingProjectId = (root: string) => createHash('sha256').update(root).digest('hex');
export function runMatches(db: DatabaseSync, r: ServiceCallRequest): boolean {
  const turn = db
    .prepare(
      `SELECT json_extract(payload,'$.codingTaskId') AS task FROM ocean_chat_turns WHERE workspace_id=? AND room_id=? AND task_run_id=? AND status='dispatching' AND json_extract(payload,'$.bot.id')=? AND review_id IS NULL
        AND json_extract(payload,'$.id')=id AND json_extract(payload,'$.status')=status
        AND json_extract(payload,'$.taskRunId')=task_run_id AND json_extract(payload,'$.bot.workspaceId')=workspace_id
        AND json_extract(payload,'$.workspaceId')=workspace_id AND json_extract(payload,'$.roomId')=room_id`,
    )
    .get(r.workspaceId, r.roomId, r.taskRunId, r.botId);
  if (!turn || turn['task'] !== r.taskId) return false;
  if (r.taskId === null) {
    if (r.projectId === null) return true;
    const ws = db.prepare('SELECT root FROM ocean_workspace WHERE id=?').get(r.workspaceId);
    return !!ws && codingProjectId(String(ws['root'])) === r.projectId;
  }
  const task = readTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(r.taskId));
  return (
    !!task &&
    task.workspaceId === r.workspaceId &&
    task.ownerRoomId === r.roomId &&
    task.devBotId === r.botId &&
    task.status === 'reserved' &&
    codingProjectId(task.projectRoot) === r.projectId
  );
}
