import { decodeChatTurn } from './chat-storage.js';
import {
  STATUS_AFTER_EVENT,
  type ChatTurnStatus,
  type TaskRunEventType,
  type Sensitivity,
} from '@runnets/domain';
import type { RoomRunReadPort, RoomRunState, RunQuery } from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { messageRow } from './conversation-rows.js';
import { readInteger, readText, readNullableText } from './rows.js';

// Null-status events advance version/accounting without changing lifecycle status.
const STATUS_EVENT = `type NOT IN (${Object.entries(STATUS_AFTER_EVENT)
  .filter(([, status]) => status === null)
  .map(([type]) => `'${type}'`)
  .join(',')})`;
const VISIBLE_TURN = `COALESCE(json_extract(payload,'$.broadcast.abandoned'),0)=0`;
const BOUND_TURN = `FROM ocean_chat_turns
      WHERE workspace_id=? AND room_id=? AND task_run_id=?
      AND ${VISIBLE_TURN}
      AND json_extract(payload,'$.workspaceId')=workspace_id AND json_extract(payload,'$.roomId')=room_id
      AND json_extract(payload,'$.taskRunId')=task_run_id AND json_extract(payload,'$.id')=id
      AND json_extract(payload,'$.status')=status`;

type Scope = Pick<RunQuery, 'workspaceId' | 'roomId'>;
/** All lookups use the runtime owner's connection. Only explicit, room-visible columns leave this adapter. */
export function roomRuntimeReads(db: DatabaseSync, now: () => number = Date.now): RoomRunReadPort {
  db.exec(`CREATE INDEX IF NOT EXISTS ocean_pending_run_decisions ON ocean_coding_approvals(
    json_extract(payload,'$.binding.runId'), json_extract(payload,'$.binding.workspaceId'),
    json_extract(payload,'$.binding.roomId'),json_extract(payload,'$.binding.botId'),json_extract(payload,'$.binding.taskId'),json_extract(payload,'$.expiresAt'),id
  ) WHERE json_extract(payload,'$.status')='pending';
  CREATE INDEX IF NOT EXISTS ocean_run_status_events ON events(aggregate_id, sequence)
    WHERE ${STATUS_EVENT};`);
  const checkRoom = ({ workspaceId, roomId }: Scope) => {
    if (
      !db
        .prepare('SELECT 1 FROM ocean_rooms WHERE workspace_id=? AND id=?')
        .get(workspaceId, roomId)
    )
      throw Error('unknown_room');
  };
  const roomSequence = (scope: Scope) => {
    checkRoom(scope);
    return readInteger(
      db
        .prepare('SELECT coalesce(max(seq),0) AS n FROM ocean_messages WHERE room_id=?')
        .get(scope.roomId)!,
      'n',
    );
  };
  const headVersion = (runId: string) =>
    readInteger(
      db
        .prepare('SELECT coalesce(max(sequence),0) AS n FROM events WHERE aggregate_id=?')
        .get(runId)!,
      'n',
    );
  function cancelTarget({ workspaceId, roomId, runId }: RunQuery) {
    const row = db.prepare(`SELECT status ${BOUND_TURN}`).get(workspaceId, roomId, runId);
    return row
      ? { turnStatus: readText(row, 'status') as ChatTurnStatus, version: headVersion(runId) }
      : null;
  }
  function run({ workspaceId, roomId, runId }: RunQuery): RoomRunState | null {
    const t = db
      .prepare(
        `SELECT *,json_extract(payload,'$.inboundMessageId') AS message,
      json_extract(payload,'$.requestId') AS request,json_extract(payload,'$.bot.id') AS bot,
      json_extract(payload,'$.codingTaskId') AS task ${BOUND_TURN}`,
      )
      .get(workspaceId, roomId, runId);
    if (!t) return null;
    const decoded = decodeChatTurn(t);
    const turnId = readText(t, 'id'),
      performerId = readText(t, 'bot'),
      turnStatus = readText(t, 'status') as ChatTurnStatus;
    const version = headVersion(runId);
    const event = db
      .prepare(
        `SELECT type FROM events WHERE aggregate_id=? AND ${STATUS_EVENT} ORDER BY sequence DESC LIMIT 1`,
      )
      .get(runId);
    const taskStatus = event
      ? STATUS_AFTER_EVENT[readText(event, 'type') as TaskRunEventType]
      : turnStatus === 'accepted'
        ? 'admitted_before_run'
        : 'not_created';
    if (!taskStatus || (!event && version !== 0)) throw Error('invalid_committed_state');
    const task = readNullableText(t, 'task');
    const at = now();
    const pendingDecisionIds = db
      .prepare(
        `SELECT d.decisionId AS id FROM ocean_owner_decisions d
      WHERE d.workspaceId=? AND d.roomId=? AND d.runId=? AND d.status='pending'
      AND d.createdAt<=? AND d.expiresAt>? AND (d.kind='continue-text-only' OR EXISTS (
        SELECT 1 FROM ocean_coding_approvals a WHERE a.id=d.decisionId AND
        json_extract(a.payload,'$.binding.workspaceId')=d.workspaceId AND
        json_extract(a.payload,'$.binding.roomId')=d.roomId AND json_extract(a.payload,'$.binding.runId')=d.runId AND
        json_extract(a.payload,'$.binding.botId')=? AND json_extract(a.payload,'$.binding.taskId')=? AND
        json_extract(a.payload,'$.status')='pending'))
      ORDER BY d.decisionId LIMIT 201`,
      )
      .all(workspaceId, roomId, runId, at, at, performerId, task)
      .map((row) => readText(row, 'id'));
    if (pendingDecisionIds.length > 200) throw Error('query_limit');
    return {
      workspaceId,
      roomId,
      runId,
      turnId,
      requestId: readText(t, 'request'),
      messageId: readText(t, 'message'),
      performerId,
      turnStatus,
      taskStatus,
      version,
      pendingDecisionIds,
      resultMessageId:
        turnStatus === 'completed' && decoded.roomSliceDisposition !== 'yielded'
          ? 'reply_' + turnId
          : null,
    };
  }
  function requireRun(query: RunQuery) {
    const state = run(query);
    if (!state) throw Error('unknown_run');
    return state;
  }
  // Count only a bounded range of indexed positions, including its previous anchor.
  function hasPositions(scope: Scope | RunQuery, after: number, through: number) {
    if (after > through || through - after > 200) return false;
    const first = Math.max(after, 1);
    let row;
    if ('runId' in scope) {
      requireRun(scope);
      row = db
        .prepare(
          'SELECT count(*) AS n FROM events WHERE aggregate_id=? AND sequence BETWEEN ? AND ?',
        )
        .get(scope.runId, first, through);
    } else {
      checkRoom(scope);
      row = db
        .prepare('SELECT count(*) AS n FROM ocean_messages WHERE room_id=? AND seq BETWEEN ? AND ?')
        .get(scope.roomId, first, through);
    }
    return row !== undefined && readInteger(row, 'n') === through - first + 1;
  }
  return {
    decisionRevision: ({ workspaceId, roomId }) =>
      readInteger(
        db
          .prepare(
            'SELECT coalesce(max(revision),0) AS n FROM ocean_owner_decisions WHERE workspaceId=? AND roomId=?',
          )
          .get(workspaceId, roomId)!,
        'n',
      ),
    hasPositions,
    cancelTarget,
    run,
    roomSequence,
    rooms(workspaceId, after, limit) {
      if (!db.prepare('SELECT 1 FROM ocean_workspace WHERE singleton=1 AND id=?').get(workspaceId))
        throw Error('unknown_workspace');
      return db
        .prepare(
          'SELECT id,kind,title,bot_id FROM ocean_rooms WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?',
        )
        .all(workspaceId, after, limit)
        .map((row) => ({
          workspaceId,
          id: readText(row, 'id'),
          kind: readText(row, 'kind') as 'direct' | 'group',
          title: readNullableText(row, 'title'),
          botId: readNullableText(row, 'bot_id'),
        }));
    },
    members(scope, after, limit) {
      checkRoom(scope);
      return db
        .prepare(
          `SELECT b.id,b.handle,b.name,b.model,b.provider FROM ocean_members m JOIN ocean_bots b ON b.id=m.bot_id AND m.workspace_id=b.workspace_id
        WHERE m.room_id=? AND m.workspace_id=? AND m.bot_id>? ORDER BY m.bot_id LIMIT ?`,
        )
        .all(scope.roomId, scope.workspaceId, after, limit)
        .map((row) => ({
          workspaceId: scope.workspaceId,
          roomId: scope.roomId,
          id: readText(row, 'id'),
          handle: readText(row, 'handle'),
          name: readText(row, 'name'),
          provider: readText(row, 'provider'),
          model: readText(row, 'model'),
        }));
    },
    *history(scope, after, limit) {
      const head = roomSequence(scope);
      if (
        after > head ||
        !hasPositions({ workspaceId: scope.workspaceId, roomId: scope.roomId }, after, after)
      )
        throw Error('resync_required');
      let seq = after;
      for (const row of db
        .prepare(
          'SELECT * FROM ocean_messages WHERE room_id=? AND workspace_id=? AND seq>? ORDER BY seq LIMIT ?',
        )
        .iterate(scope.roomId, scope.workspaceId, after, limit)) {
        if (readInteger(row, 'seq') !== ++seq) throw Error('resync_required');
        yield messageRow(row);
      }
      if (seq < Math.min(after + limit, head)) throw Error('resync_required');
    },
    *runs(scope, after, limit) {
      checkRoom(scope);
      for (const row of db
        .prepare(
          `SELECT task_run_id FROM ocean_chat_turns
           WHERE room_id=? AND workspace_id=? AND id>? AND ${VISIBLE_TURN} ORDER BY id LIMIT ?`,
        )
        .iterate(scope.roomId, scope.workspaceId, after, limit))
        yield requireRun({ ...scope, runId: readText(row, 'task_run_id') });
    },
    events(query, after, limit) {
      const { version } = requireRun(query);
      const events = db
        .prepare(
          'SELECT sequence,type,sensitivity FROM events WHERE aggregate_id=? AND sequence>? ORDER BY sequence LIMIT ?',
        )
        .all(query.runId, after, limit)
        .map((row) => ({
          sequence: readInteger(row, 'sequence'),
          type: row['sensitivity'] === 'restricted' ? 'redacted' : readText(row, 'type'),
          sensitivity: readText(row, 'sensitivity') as Sensitivity,
        }));
      if (
        after > version ||
        !hasPositions(query, after, after) ||
        events.length !== Math.min(limit, version - after) ||
        events.some((e, i) => e.sequence !== after + i + 1)
      )
        throw Error('resync_required');
      return events;
    },
    result(query) {
      const { resultMessageId, turnId } = requireRun(query);
      if (!resultMessageId) return null;
      const row = db
        .prepare(
          "SELECT * FROM ocean_messages WHERE workspace_id=? AND room_id=? AND turn_id=? AND id=? AND author='bot'",
        )
        .get(query.workspaceId, query.roomId, turnId, resultMessageId);
      if (!row) throw Error('resync_required');
      return messageRow(row);
    },
  };
}
