import { copyModelActivationSnapshot, copyBotModelBinding, type ChatTurn } from '@runnets/domain';
import type { ConversationTransaction } from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { readText } from './rows.js';
type ChatStorage = Pick<
  ConversationTransaction,
  'chatTurn' | 'roomChatRun' | 'chatTurns' | 'activeChatTurn' | 'putChatTurn'
>;
export function decodeChatTurn(row: Record<string, unknown>): ChatTurn {
  const value: unknown = JSON.parse(readText(row, 'payload'));
  if (
    value === null ||
    typeof value !== 'object' ||
    !('id' in value) ||
    !('status' in value) ||
    value.id !== row['id'] ||
    value.status !== row['status']
  )
    throw new Error('Invalid persisted chat turn');
  const marker = 'continuationReviewId' in value ? value.continuationReviewId : null;
  if ('review_id' in row && row['review_id'] !== marker)
    throw new Error('Inconsistent continuation review');
  if ('activation' in value) copyModelActivationSnapshot(value.activation);
  if ('modelBinding' in value) copyBotModelBinding(value.modelBinding);
  validateRoomSlice(value as ChatTurn);
  const t = value as ChatTurn;
  if (
    t.roomDelivery &&
    (t.taskRunId !== row['task_run_id'] ||
      t.workspaceId !== row['workspace_id'] ||
      t.roomId !== row['room_id'])
  )
    throw Error('foreign room marker');
  return value as ChatTurn;
}
/** Chat phase updates share the surrounding conversation transaction and SQLite constraints. */
export function chatStorage(db: DatabaseSync): ChatStorage {
  const marked =
    Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']) >= 27;
  return {
    chatTurn(id) {
      const row = db.prepare('SELECT * FROM ocean_chat_turns WHERE id=?').get(id);
      return row === undefined ? null : decodeChatTurn(row);
    },
    roomChatRun(workspaceId, roomId, runId) {
      const row = db
        .prepare(
          'SELECT * FROM ocean_chat_turns WHERE task_run_id=? AND room_id=? AND workspace_id=?',
        )
        .get(runId, roomId, workspaceId);
      return row === undefined ? null : decodeChatTurn(row);
    },
    chatTurns: () => db.prepare('SELECT * FROM ocean_chat_turns').all().map(decodeChatTurn),
    activeChatTurn(roomId) {
      const row = db
        .prepare(
          "SELECT * FROM ocean_chat_turns WHERE room_id=? AND status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL" +
            (marked ? " AND json_extract(payload,'$.roomDelivery') IS NULL" : ''),
        )
        .get(roomId);
      return row === undefined ? null : decodeChatTurn(row);
    },
    putChatTurn(turn) {
      db.prepare(
        `INSERT INTO ocean_chat_turns(id,workspace_id,room_id,task_run_id,status,payload,review_id) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload,review_id=excluded.review_id`,
      ).run(
        turn.id,
        turn.workspaceId,
        turn.roomId,
        turn.taskRunId,
        turn.status,
        JSON.stringify(turn),
        turn.continuationReviewId ?? null,
      );
    },
  };
}

/** Reject malformed optional lifecycle fields before any final projection. */
function validateRoomSlice(t: ChatTurn): void {
  const m = t.roomDelivery,
    p = t.roomHandoff;
  if (
    m !== undefined &&
    (!m ||
      Object.keys(m).sort().join() !== 'deliveryId,taskId,version' ||
      m.version !== 1 ||
      ![m.taskId, m.deliveryId].every(
        (s) => typeof s === 'string' && s.length > 0 && s.length <= 128,
      ) ||
      t.broadcast !== undefined ||
      t.codingTaskId !== undefined)
  )
    throw Error('invalid room marker');
  if (
    p !== undefined &&
    (!m ||
      !p ||
      Object.keys(p).sort().join() !==
        'attemptId,callId,childTaskId,deliveryId,expectedRunVersion,taskRunId,turnId,version' ||
      p.version !== 1 ||
      p.turnId !== t.id ||
      p.taskRunId !== t.taskRunId ||
      ![p.attemptId, p.callId, p.childTaskId, p.deliveryId].every(
        (s) => typeof s === 'string' && s.length > 0,
      ) ||
      !Number.isSafeInteger(p.expectedRunVersion) ||
      p.expectedRunVersion < 1)
  )
    throw Error('invalid room handoff');
  if (
    t.roomSliceDisposition !== undefined &&
    (t.roomSliceDisposition !== 'yielded' ||
      !p ||
      t.status !== 'completed' ||
      t.text !== '' ||
      t.preparedVersion !== null)
  )
    throw Error('invalid room disposition');
}
