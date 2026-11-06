import type { DatabaseSync } from 'node:sqlite';
/** Reconstruct BASE12c6848's actual v26 message/hold DDL, removing every v27 object. */
export function omitRoomTaskSchema(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ocean_room_tasks'").get()) return;
  const foreign = db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'] === 1;
  if (foreign) db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec(`
    DROP TRIGGER IF EXISTS ocean_room_slice_insert; DROP TRIGGER IF EXISTS ocean_room_slice_update;
    DROP TRIGGER IF EXISTS ocean_room_proof_immutable;
    DROP TRIGGER IF EXISTS ocean_room_coding_immutable;
    DROP TRIGGER ocean_room_turn_insert; DROP TRIGGER ocean_room_turn_immutable;
    DROP INDEX ocean_room_delivery_turn; DROP INDEX ocean_room_task_hold;
    DROP INDEX ocean_chat_room_hold;
    CREATE UNIQUE INDEX ocean_chat_room_hold ON ocean_chat_turns(room_id)
      WHERE status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL;
    DROP TABLE ocean_room_deliveries; DROP TABLE ocean_room_tasks;
    DROP TRIGGER ocean_direct_target; DROP TRIGGER ocean_addressed_message;
    CREATE TABLE ocean_messages_old(
      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq>=1),author TEXT NOT NULL CHECK(author IN ('user','bot')),
      target_bot_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL,
      author_bot_id TEXT,turn_id TEXT,UNIQUE(room_id,seq),UNIQUE(turn_id),
      CHECK((author='user' AND author_bot_id IS NULL AND turn_id IS NULL)
        OR (author='bot' AND author_bot_id IS NOT NULL AND target_bot_id IS NOT NULL
          AND author_bot_id=target_bot_id AND turn_id IS NOT NULL)),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(room_id,target_bot_id) REFERENCES ocean_members(room_id,bot_id),
      FOREIGN KEY(room_id,turn_id) REFERENCES ocean_chat_turns(room_id,id)
    ) STRICT;
    INSERT INTO ocean_messages_old SELECT * FROM ocean_messages;
    DROP TABLE ocean_messages; ALTER TABLE ocean_messages_old RENAME TO ocean_messages;
    CREATE TRIGGER ocean_direct_target BEFORE INSERT ON ocean_messages
    WHEN (SELECT kind FROM ocean_rooms WHERE id=NEW.room_id)='direct' AND NEW.target_bot_id IS NULL
    BEGIN SELECT RAISE(ABORT,'direct message requires a target'); END;
  `);
  } finally {
    if (foreign) db.exec('PRAGMA foreign_keys=ON');
  }
}
