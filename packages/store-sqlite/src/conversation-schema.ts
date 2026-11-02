import type { DatabaseSync } from 'node:sqlite';

export const CONVERSATION_TABLES = [
  'ocean_workspace',
  'ocean_bots',
  'ocean_rooms',
  'ocean_members',
  'ocean_messages',
  'ocean_receipts',
] as const;

/** Add M1 data without rewriting any existing task stream, receipt or tool claim. */
export function migrateConversations(db: DatabaseSync): void {
  db.exec(`
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
  `);
}

/** A known live or unverifiable owner must never have its schema changed underneath it. */
export function assertMigrationOwnerAbsent(db: DatabaseSync): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_owner_v1'")
    .get();
  if (exists === undefined) return;
  const row = db.prepare('SELECT pid FROM runtime_owner_v1 WHERE singleton=1').get();
  if (row === undefined) return;
  const pid = row['pid'];
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Schema migration refused: runtime owner is unverified');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    throw new Error('Schema migration refused: runtime owner is unverified');
  }
  throw new Error('Schema migration refused: runtime owner is live');
}
