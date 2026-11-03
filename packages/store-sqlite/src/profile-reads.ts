import type { DatabaseSync } from 'node:sqlite';
import { botRow } from './conversation-rows.js';
import { unresolvedEffectSql } from './tool-effect-resolution.js';
import { readText, readInteger } from './rows.js';
/** Only the authenticated owner's workspace, project lease identity and room membership can bind a coding application. */
export function profileReads(db: DatabaseSync, ownerId: string) {
  const from = `FROM ocean_coding_applications a JOIN ocean_coding_tasks t ON t.id=json_extract(a.payload,'$.taskId')
 JOIN ocean_members m ON m.room_id=t.owner_room_id AND m.workspace_id=t.workspace_id AND m.bot_id=t.dev_bot_id
 WHERE t.id=json_extract(t.payload,'$.id') AND t.workspace_id=json_extract(t.payload,'$.workspaceId')
 AND t.owner_room_id=json_extract(t.payload,'$.ownerRoomId') AND t.dev_bot_id=json_extract(t.payload,'$.devBotId')
 AND a.id=json_extract(a.payload,'$.id') AND t.workspace_id=? AND json_extract(t.payload,'$.lease.ownerId')=? AND (? IS NULL OR m.room_id=?)`;
  const pending = `FROM tool_invocations_v2 e WHERE ${unresolvedEffectSql('e')}`;
  const scoped = `${pending} AND e.tool='coding_apply' AND e.task_run_id='apply-'||e.id AND e.attempt_id='apply' AND EXISTS(SELECT 1 ${from} AND a.id=e.id)`;
  const checkWorkspace = (workspaceId: string) => {
    if (!db.prepare('SELECT 1 FROM ocean_workspace WHERE id=?').get(workspaceId))
      throw Error('unknown_workspace');
  };
  return {
    bots(workspaceId: string, after: string, limit: number) {
      checkWorkspace(workspaceId);
      return db
        .prepare('SELECT * FROM ocean_bots WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?')
        .all(workspaceId, after, limit)
        .map(botRow);
    },
    applicationTask(workspaceId: string, id: string, roomId: string | null) {
      const row = db
        .prepare('SELECT t.id ' + from + ' AND a.id=?')
        .get(workspaceId, ownerId, roomId, roomId, id);
      return row ? readText(row, 'id') : null;
    },
    pending(workspaceId: string, roomId: string | null, after: string, limit: number) {
      checkWorkspace(workspaceId);
      const params = [workspaceId, ownerId, roomId, roomId];
      const counts = db
        .prepare(
          `SELECT (SELECT count(*) FROM tool_invocations_v1 WHERE outcome IN ('started','uncertain'))+(SELECT count(*) ${pending})-(SELECT count(*) ${scoped}) AS omitted`,
        )
        .get(...params)!;
      return {
        applications: db
          .prepare('SELECT e.id,e.outcome ' + scoped + ' AND e.id>? ORDER BY e.id LIMIT ?')
          .all(...params, after, limit)
          .map((r) => ({ applicationId: readText(r, 'id'), outcome: readText(r, 'outcome') })),
        omittedPendingEffects: readInteger(counts, 'omitted'),
      };
    },
  };
}
export type ProfileReads = ReturnType<typeof profileReads>;
