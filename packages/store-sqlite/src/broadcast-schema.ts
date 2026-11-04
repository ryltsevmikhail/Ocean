import type { DatabaseSync } from 'node:sqlite';

export const BROADCAST_TABLES = ['ocean_broadcast_batches'] as const;
/** Schema 16: durable queued child turns, one-target-less broadcast message, batch receipt. */
export function migrateBroadcasts(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE ocean_chat_turns_v16 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      task_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('queued','accepted','dispatching','prepared','completed','failed','uncertain','cancelled')),
      payload TEXT NOT NULL,
      review_id TEXT REFERENCES ocean_reviews(id),
      UNIQUE(room_id,id),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id)
    ) STRICT;
    INSERT INTO ocean_chat_turns_v16
      SELECT id,workspace_id,room_id,task_run_id,status,payload,review_id FROM ocean_chat_turns;
    DROP TABLE ocean_chat_turns;
    ALTER TABLE ocean_chat_turns_v16 RENAME TO ocean_chat_turns;
    CREATE UNIQUE INDEX ocean_chat_room_hold ON ocean_chat_turns(room_id)
      WHERE status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL;
    CREATE TRIGGER ocean_review_immutable BEFORE UPDATE OF review_id ON ocean_chat_turns
      WHEN OLD.review_id IS NOT NULL AND NEW.review_id IS NOT OLD.review_id
      BEGIN SELECT RAISE(ABORT,'continuation review is immutable'); END;
    CREATE TRIGGER ocean_review_turn BEFORE UPDATE OF review_id ON ocean_chat_turns
      WHEN NEW.review_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM ocean_reviews WHERE id=NEW.review_id AND turn_id=NEW.id AND room_id=NEW.room_id)
      BEGIN SELECT RAISE(ABORT,'continuation review has wrong turn'); END;
    CREATE INDEX ocean_chat_broadcast ON ocean_chat_turns(json_extract(payload,'$.broadcast.batchId'))
      WHERE json_extract(payload,'$.broadcast.version')=1;

    CREATE TABLE IF NOT EXISTS ocean_broadcast_batches (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      binding TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      boundary_seq INTEGER NOT NULL CHECK(boundary_seq>=1),
      recipients TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','paused','completed','abandoned')),
      revision INTEGER NOT NULL CHECK(revision>=1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(room_id,id),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(message_id) REFERENCES ocean_messages(id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS ocean_broadcast_open ON ocean_broadcast_batches(room_id)
      WHERE state IN ('open','paused');
  `);
}
