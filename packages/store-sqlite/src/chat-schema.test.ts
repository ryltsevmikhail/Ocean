import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './schema.js';
import { ConversationService } from '@runnets/application';
import { SqliteConversationStore } from './conversations.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function versionTwo() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  dbs.push(db);
  initializeSchema(db);
  let id = 0;
  const s = new ConversationService({
    store: new SqliteConversationStore(db),
    clock: { now: () => new Date('2026-11-02T00:00:00Z') },
    nextId: () => String(++id),
  });
  s.execute({ type: 'BindWorkspace', requestId: 'init', workspaceId: 'w', root: '/project' });
  s.execute({
    type: 'CreateBot',
    requestId: 'bot',
    workspaceId: 'w',
    handle: 'dev',
    name: 'Dev',
    role: 'Role',
    provider: 'deepseek',
    model: 'test',
  });
  s.execute({ type: 'OpenDirectRoom', requestId: 'room', workspaceId: 'w', botId: '1' });
  s.execute({
    type: 'RecordUserMessage',
    requestId: 'message',
    workspaceId: 'w',
    roomId: '2',
    text: 'saved in M1',
  });
  // Reproduce the M1 message table shape and version while retaining all M1 data.
  db.exec(`ALTER TABLE ocean_messages RENAME TO messages_v3;
    CREATE TABLE ocean_messages(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL,
      seq INTEGER NOT NULL, author TEXT NOT NULL CHECK(author='user'),target_bot_id TEXT NOT NULL,
      body TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(room_id,seq),
      FOREIGN KEY(workspace_id,room_id) REFERENCES ocean_rooms(workspace_id,id),
      FOREIGN KEY(room_id,target_bot_id) REFERENCES ocean_members(room_id,bot_id)
    ) STRICT;
    INSERT INTO ocean_messages SELECT id,workspace_id,room_id,seq,author,target_bot_id,body,created_at FROM messages_v3;
    DROP TABLE messages_v3;
    DROP TABLE ocean_chat_turns;
    UPDATE meta SET value='2' WHERE key='schema_version';
  `);
  return { db, s };
}
it('preserves actual M1 message rows, profiles, memberships and receipts in schema 2→3', () => {
  const { db, s } = versionTwo();
  const tables = ['ocean_bots', 'ocean_rooms', 'ocean_members', 'ocean_receipts'];
  const before = tables.map((t) => db.prepare('SELECT * FROM ' + t).all());
  const history = s.history('w', '2');
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '3',
  );
  expect(tables.map((t) => db.prepare('SELECT * FROM ' + t).all())).toEqual(before);
  expect(s.history('w', '2')).toEqual(history);
  initializeSchema(db);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('leaves version 2 and its old messages intact when the migration fails partway', () => {
  const { db, s } = versionTwo();
  db.exec('CREATE TABLE ocean_chat_turns(collision TEXT)');
  expect(() => initializeSchema(db)).toThrow();
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '2',
  );
  expect(s.history('w', '2')).toMatchObject({ value: [{ body: 'saved in M1' }] });
});
