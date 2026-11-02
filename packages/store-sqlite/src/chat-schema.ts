import type { DatabaseSync } from 'node:sqlite';
export const CHAT_TABLES = ['ocean_chat_turns'] as const;
/** Schema 3 preserves M1 user records while allowing attributed, once-published bot answers. */
export function migrateChats(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE ocean_chat_turns (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      task_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('accepted','dispatching','prepared','completed','failed','uncertain','cancelled')),
      payload TEXT NOT NULL,
      UNIQUE(room_id,id),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id)
    ) STRICT;
    CREATE UNIQUE INDEX ocean_chat_room_hold ON ocean_chat_turns(room_id)
      WHERE status IN ('accepted','dispatching','prepared','uncertain');
    ALTER TABLE ocean_messages RENAME TO ocean_messages_v2;
    CREATE TABLE ocean_messages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq>=1),
      author TEXT NOT NULL CHECK(author IN ('user','bot')),
      target_bot_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
      author_bot_id TEXT, turn_id TEXT,
      UNIQUE(room_id,seq), UNIQUE(turn_id),
      CHECK((author='user' AND author_bot_id IS NULL AND turn_id IS NULL)
        OR (author='bot' AND author_bot_id=target_bot_id AND author_bot_id IS NOT NULL AND turn_id IS NOT NULL)),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(room_id,target_bot_id) REFERENCES ocean_members(room_id,bot_id),
      FOREIGN KEY(room_id,turn_id) REFERENCES ocean_chat_turns(room_id,id)
    ) STRICT;
    INSERT INTO ocean_messages
      SELECT *,NULL,NULL FROM ocean_messages_v2;
    DROP TABLE ocean_messages_v2;
  `);
}
