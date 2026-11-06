import type { DatabaseSync } from 'node:sqlite';
import type { RoomAuthorityRead, ConversationReceipt } from '@runnets/application';
import { taskRunId } from '@runnets/domain';
import { chatStorage } from './chat-storage.js';
import { messageRow } from './conversation-rows.js';
import { committedTaskVersion } from './event-log.js';
import { inspectPendingEffects } from './tool-journal-reads.js';
/** Historical evidence reads remain inside the caller's existing authority lock. */
export function roomAuthorityEvidence(
  db: DatabaseSync,
): Pick<RoomAuthorityRead, 'receipt' | 'history' | 'chatTurn' | 'chatFailureEvidence'> {
  return {
    chatTurn: chatStorage(db).chatTurn,
    history: (room, after, limit) =>
      db
        .prepare('SELECT * FROM ocean_messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?')
        .all(room, after, limit)
        .map(messageRow),
    receipt(id) {
      const row = db.prepare('SELECT binding,reply FROM ocean_receipts WHERE request_id=?').get(id);
      if (!row) return null;
      const reply: unknown = JSON.parse(String(row['reply']));
      if (
        !reply ||
        typeof reply !== 'object' ||
        !('kind' in reply) ||
        reply.kind !== 'message' ||
        !('data' in reply)
      )
        return null;
      return { binding: String(row['binding']), reply } as ConversationReceipt;
    },
    chatFailureEvidence(id) {
      if (!db.isTransaction) return null;
      return {
        taskVersion: committedTaskVersion(db, taskRunId(id)),
        relatedPendingEffects: inspectPendingEffects(db).filter(
          (e) => e.taskRunId === id || e.taskRunId === '',
        ).length,
      };
    },
  };
}
