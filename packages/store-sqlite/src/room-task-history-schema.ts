import type { DatabaseSync } from 'node:sqlite';
/** Preserve the ten physical columns and old rows while allowing backed peer publications. */
export function migrateRoomTaskHistory(db: DatabaseSync): void {
  db.exec(`
  DROP TRIGGER ocean_direct_target;
  CREATE TABLE ocean_messages_new(
    id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK(seq>=1),author TEXT NOT NULL CHECK(author IN ('user','bot')),
    target_bot_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL,
    author_bot_id TEXT,turn_id TEXT,UNIQUE(room_id,seq),UNIQUE(room_id,seq,id),
    CHECK((author='user' AND author_bot_id IS NULL AND turn_id IS NULL)
      OR (author='bot' AND author_bot_id IS NOT NULL AND target_bot_id IS NOT NULL AND turn_id IS NOT NULL)),
    FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
    FOREIGN KEY(room_id,target_bot_id) REFERENCES ocean_members(room_id,bot_id),
    FOREIGN KEY(room_id,turn_id) REFERENCES ocean_chat_turns(room_id,id)
  ) STRICT;
  INSERT INTO ocean_messages_new SELECT * FROM ocean_messages;
  DROP TABLE ocean_messages;
  ALTER TABLE ocean_messages_new RENAME TO ocean_messages;
  CREATE UNIQUE INDEX ocean_message_final ON ocean_messages(turn_id)
    WHERE author='bot' AND author_bot_id=target_bot_id;
  CREATE TRIGGER ocean_direct_target BEFORE INSERT ON ocean_messages
    WHEN (SELECT kind FROM ocean_rooms WHERE id=NEW.room_id)='direct' AND NEW.target_bot_id IS NULL
    BEGIN SELECT RAISE(ABORT,'direct message requires a target'); END;
  CREATE TRIGGER ocean_addressed_message BEFORE INSERT ON ocean_messages
  WHEN NEW.author='bot' AND NEW.author_bot_id<>NEW.target_bot_id AND NOT EXISTS(
    SELECT 1 FROM ocean_room_deliveries d JOIN ocean_chat_turns c ON c.id=d.source_turn_id
    JOIN ocean_room_deliveries i ON i.id=d.cause_id
    WHERE d.message_id=NEW.id AND d.seq=NEW.seq AND d.room_id=NEW.room_id
      AND d.workspace_id=NEW.workspace_id AND d.sender_bot_id=NEW.author_bot_id
      AND d.recipient_bot_id=NEW.target_bot_id AND d.source_turn_id=NEW.turn_id
      AND d.kind IN ('message','delegate')
      AND json_extract(c.payload,'$.roomDelivery.deliveryId')=i.id
      AND json_extract(c.payload,'$.roomDelivery.taskId')=d.from_task_id
      AND i.to_task_id=d.from_task_id AND i.root_id=d.root_id)
  BEGIN SELECT RAISE(ABORT,'addressed message requires delivery'); END;
  `);
}

/** Also install on previously-created v27 snapshots; history facts cannot be rewritten. */
export function protectRoomTaskHistory(db: DatabaseSync): void {
  db.exec(`CREATE TRIGGER IF NOT EXISTS ocean_message_immutable BEFORE UPDATE ON ocean_messages
    WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.room_id IS NOT OLD.room_id
      OR NEW.seq IS NOT OLD.seq OR NEW.author IS NOT OLD.author OR NEW.target_bot_id IS NOT OLD.target_bot_id
      OR NEW.body IS NOT OLD.body OR NEW.created_at IS NOT OLD.created_at
      OR NEW.author_bot_id IS NOT OLD.author_bot_id OR NEW.turn_id IS NOT OLD.turn_id
    BEGIN SELECT RAISE(ABORT,'immutable conversation message'); END;`);
}
