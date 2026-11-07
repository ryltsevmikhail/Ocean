import type { DatabaseSync } from 'node:sqlite';
import { readText } from './rows.js';

export function readProfileCodingTasks(
  db: DatabaseSync,
  workspaceId: string,
  projectRoot: string,
  ownerId: string,
  after: string,
  limit: number,
) {
  // At most one extra row to decide whether a subsequent page exists.
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 51) throw Error('query_limit');
  return db
    .prepare(
      `SELECT t.id,t.status,t.owner_room_id,t.dev_bot_id,t.review_room_id,t.review_bot_id,
        CASE WHEN w.state='ready'
          AND w.root=json_extract(t.payload,'$.worktreeRoot')
          AND w.root=json_extract(w.payload,'$.root')
          AND w.state=json_extract(w.payload,'$.state')
          AND t.id=json_extract(w.payload,'$.taskId')
          AND t.workspace_id=json_extract(w.payload,'$.workspaceId')
          AND t.project_root=json_extract(w.payload,'$.projectRoot')
          THEN 1 ELSE 0 END AS worktree_ready
       FROM ocean_coding_tasks t
       JOIN ocean_members m ON m.room_id=t.owner_room_id AND m.workspace_id=t.workspace_id AND m.bot_id=t.dev_bot_id
       JOIN ocean_rooms r ON r.id=m.room_id AND r.workspace_id=m.workspace_id
       JOIN ocean_bots b ON b.id=m.bot_id AND b.workspace_id=m.workspace_id
       LEFT JOIN ocean_worktrees w ON w.task_id=t.id
       WHERE t.workspace_id=? AND t.project_root=? AND json_extract(t.payload,'$.lease.ownerId')=?
       AND t.id=json_extract(t.payload,'$.id')
       AND t.workspace_id=json_extract(t.payload,'$.workspaceId')
       AND t.project_root=json_extract(t.payload,'$.projectRoot')
       AND t.owner_room_id=json_extract(t.payload,'$.ownerRoomId')
       AND t.dev_bot_id=json_extract(t.payload,'$.devBotId')
       AND t.review_room_id=json_extract(t.payload,'$.reviewRoomId')
       AND t.review_bot_id=json_extract(t.payload,'$.reviewBotId')
       AND t.status=json_extract(t.payload,'$.status')
       AND t.id>? ORDER BY t.id LIMIT ?`,
    )
    .all(workspaceId, projectRoot, ownerId, after, limit)
    .map((r) => ({
      id: readText(r, 'id'),
      status: readText(r, 'status'),
      ownerRoomId: readText(r, 'owner_room_id'),
      devBotId: readText(r, 'dev_bot_id'),
      reviewRoomId: readText(r, 'review_room_id'),
      reviewBotId: readText(r, 'review_bot_id'),
      worktreeReady: r['worktree_ready'] === 1,
    }));
}
