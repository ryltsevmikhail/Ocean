-- Frozen synthetic schema from public M3 revision 53c0a04.
PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (aggregate_id, sequence),
  CHECK (sequence >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  events TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS checkpoints (
  aggregate_id TEXT NOT NULL,
  event_position INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  snapshot TEXT,
  PRIMARY KEY (aggregate_id, event_position),
  CHECK (event_position >= 1),
  FOREIGN KEY (aggregate_id, event_position) REFERENCES events (aggregate_id, sequence)
) STRICT;

ALTER TABLE command_receipts ADD COLUMN request_binding TEXT;

    CREATE TABLE ocean_workspace (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      id TEXT NOT NULL UNIQUE, root TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE ocean_bots (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES ocean_workspace(id),
      handle TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL,
      profile_version INTEGER NOT NULL CHECK(profile_version >= 1),
      UNIQUE(workspace_id,handle), UNIQUE(workspace_id,id)
    ) STRICT;
    CREATE TABLE ocean_rooms (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind = 'direct'), bot_id TEXT NOT NULL,
      UNIQUE(workspace_id,bot_id), UNIQUE(workspace_id,id),
      FOREIGN KEY(workspace_id,bot_id) REFERENCES ocean_bots(workspace_id,id)
    ) STRICT;
    CREATE TABLE ocean_members (
      workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, bot_id TEXT NOT NULL,
      PRIMARY KEY(room_id,bot_id),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(workspace_id,bot_id) REFERENCES ocean_bots(workspace_id,id)
    ) STRICT;
    CREATE TABLE ocean_messages (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq >= 1), author TEXT NOT NULL CHECK(author = 'user'),
      target_bot_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(room_id,seq),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(room_id,target_bot_id) REFERENCES ocean_members(room_id,bot_id)
    ) STRICT;
    CREATE TABLE ocean_receipts (
      request_id TEXT PRIMARY KEY, binding TEXT NOT NULL, reply TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER ocean_direct_member BEFORE INSERT ON ocean_members
    WHEN NEW.bot_id != (SELECT bot_id FROM ocean_rooms WHERE id = NEW.room_id)
    BEGIN SELECT RAISE(ABORT, 'direct room member mismatch'); END;

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

INSERT INTO meta VALUES('schema_version','4');
PRAGMA foreign_keys=ON;
