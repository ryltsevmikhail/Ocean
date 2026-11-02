import type { DatabaseSync } from 'node:sqlite';

/** Rebuild parent tables with foreign keys disabled only for this checked migration transaction. */
export function migrateGroups(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER ocean_direct_member;
    CREATE TABLE ocean_rooms_new(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('direct','group')),bot_id TEXT,title TEXT,
      CHECK((kind='direct' AND bot_id IS NOT NULL AND title IS NULL)
        OR (kind='group' AND bot_id IS NULL AND title IS NOT NULL)),
      UNIQUE(workspace_id,bot_id),UNIQUE(workspace_id,id),
      FOREIGN KEY(workspace_id) REFERENCES ocean_workspace(id),
      FOREIGN KEY(workspace_id,bot_id) REFERENCES ocean_bots(workspace_id,id)
    ) STRICT;
    INSERT INTO ocean_rooms_new SELECT *,NULL FROM ocean_rooms;
    DROP TABLE ocean_rooms;
    ALTER TABLE ocean_rooms_new RENAME TO ocean_rooms;
    CREATE TABLE ocean_messages_new(
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
    INSERT INTO ocean_messages_new SELECT * FROM ocean_messages;
    DROP TABLE ocean_messages;
    ALTER TABLE ocean_messages_new RENAME TO ocean_messages;
    CREATE TRIGGER ocean_direct_member BEFORE INSERT ON ocean_members
    WHEN (SELECT kind FROM ocean_rooms WHERE id=NEW.room_id)='direct'
      AND NEW.bot_id!=(SELECT bot_id FROM ocean_rooms WHERE id=NEW.room_id)
    BEGIN SELECT RAISE(ABORT,'direct room member mismatch'); END;
    CREATE TRIGGER ocean_direct_target BEFORE INSERT ON ocean_messages
    WHEN (SELECT kind FROM ocean_rooms WHERE id=NEW.room_id)='direct' AND NEW.target_bot_id IS NULL
    BEGIN SELECT RAISE(ABORT,'direct message requires a target'); END;
  `);
}
