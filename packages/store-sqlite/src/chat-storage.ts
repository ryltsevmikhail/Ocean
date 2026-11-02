import type { ChatTurn } from '@runnets/domain';
import type { ConversationTransaction } from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { readText } from './rows.js';
type ChatStorage = Pick<
  ConversationTransaction,
  'chatTurn' | 'chatTurns' | 'activeChatTurn' | 'putChatTurn'
>;
function decode(row: Record<string, unknown>): ChatTurn {
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
  return value as ChatTurn;
}
/** Chat phase updates share the surrounding conversation transaction and SQLite constraints. */
export function chatStorage(db: DatabaseSync): ChatStorage {
  return {
    chatTurn(id) {
      const row = db.prepare('SELECT * FROM ocean_chat_turns WHERE id=?').get(id);
      return row === undefined ? null : decode(row);
    },
    chatTurns: () => db.prepare('SELECT * FROM ocean_chat_turns').all().map(decode),
    activeChatTurn(roomId) {
      const row = db
        .prepare(
          "SELECT * FROM ocean_chat_turns WHERE room_id=? AND status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL",
        )
        .get(roomId);
      return row === undefined ? null : decode(row);
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
