import type { ChatReview } from '@runnets/domain';
import type { ConversationTransaction } from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { readText } from './rows.js';
type ReviewStorage = Pick<
  ConversationTransaction,
  'review' | 'putReview' | 'roomPolicy' | 'putRoomPolicy'
>;
/** Audit rows, profile restriction and receipt participate in one surrounding transaction. */
export function reviewStorage(db: DatabaseSync): ReviewStorage {
  return {
    review(id) {
      const row = db.prepare('SELECT payload FROM ocean_reviews WHERE id=?').get(id);
      if (row === undefined) return null;
      const value: unknown = JSON.parse(readText(row, 'payload'));
      if (value === null || typeof value !== 'object' || !('id' in value) || value.id !== id)
        throw new Error('Invalid review');
      return value as ChatReview;
    },
    putReview(r) {
      db.prepare('INSERT INTO ocean_reviews VALUES(?,?,?,?,?,?,?)').run(
        r.id,
        r.workspaceId,
        r.roomId,
        r.taskRunId,
        r.turnId,
        r.noticeMessageId,
        JSON.stringify(r),
      );
    },
    roomPolicy(roomId) {
      const row = db.prepare('SELECT * FROM ocean_room_policies WHERE room_id=?').get(roomId);
      if (row === undefined) return null;
      if (row['mode'] !== 'text_only') throw new Error('Invalid room policy');
      return { roomId, mode: 'text_only', reviewId: readText(row, 'review_id') };
    },
    putRoomPolicy(p) {
      db.prepare(
        `INSERT INTO ocean_room_policies VALUES(?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET review_id=excluded.review_id,mode=excluded.mode`,
      ).run(p.roomId, p.mode, p.reviewId);
    },
  };
}
