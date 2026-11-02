import type { DatabaseSync } from 'node:sqlite';
export const REVIEW_TABLES = ['ocean_reviews', 'ocean_room_policies'] as const;
/** Release only a reviewed room hold, retaining the old status and all effect claims. */
export function migrateReviews(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE ocean_reviews(
    id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,
    task_run_id TEXT NOT NULL,turn_id TEXT NOT NULL UNIQUE,notice_message_id TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,UNIQUE(room_id,id),
    FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
    FOREIGN KEY(room_id,turn_id) REFERENCES ocean_chat_turns(room_id,id),
    FOREIGN KEY(notice_message_id) REFERENCES ocean_messages(id)
  ) STRICT;
  CREATE TABLE ocean_room_policies(
    room_id TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode='text_only'),
    review_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY(room_id,review_id) REFERENCES ocean_reviews(room_id,id)
  ) STRICT;
  ALTER TABLE ocean_chat_turns ADD COLUMN review_id TEXT REFERENCES ocean_reviews(id);
  DROP INDEX ocean_chat_room_hold;
  CREATE UNIQUE INDEX ocean_chat_room_hold ON ocean_chat_turns(room_id)
    WHERE status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL;
  CREATE TRIGGER ocean_review_immutable BEFORE UPDATE OF review_id ON ocean_chat_turns
    WHEN OLD.review_id IS NOT NULL AND NEW.review_id IS NOT OLD.review_id
    BEGIN SELECT RAISE(ABORT,'continuation review is immutable'); END;
  CREATE TRIGGER ocean_review_turn BEFORE UPDATE OF review_id ON ocean_chat_turns
    WHEN NEW.review_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM ocean_reviews WHERE id=NEW.review_id AND turn_id=NEW.id AND room_id=NEW.room_id)
    BEGIN SELECT RAISE(ABORT,'continuation review has wrong turn'); END;
 `);
}
