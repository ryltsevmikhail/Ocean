import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import {
  ConversationService,
  DirectChatService,
  TaskRunService,
  type ProviderPort,
} from '@runnets/application';
import { SqliteConversationStore } from './conversations.js';
import { SqliteEventLog } from './event-log.js';
import { createDurableIdGenerator } from './id-source.js';
import { initializeSchema } from './schema.js';
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function oldProfile() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  dbs.push(db);
  db.exec(readFileSync(new URL('./fixtures/ocean-schema-v3.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO ocean_workspace VALUES(1,'ws_test','/project')");
  db.exec("INSERT INTO ocean_bots VALUES('0001','ws_test','dev','Dev','Role','test','test',1)");
  db.exec("INSERT INTO ocean_rooms VALUES('0002','ws_test','direct','0001')");
  db.exec("INSERT INTO ocean_members VALUES('ws_test','0002','0001')");
  const ids = createDurableIdGenerator(db);
  const clock = { now: () => new Date('2026-11-02T00:00:00Z') };
  const tasks = new TaskRunService({ log: new SqliteEventLog(db, ids), clock, ids });
  const store = new SqliteConversationStore(db);
  let id = 10;
  const nextId = () => String(++id).padStart(4, '0');
  const conversations = new ConversationService({ store, clock, nextId });
  const chat = new DirectChatService({ store, tasks, clock, nextId });
  return { db, conversations, chat };
}
it('preserves M2 replies, turns, TaskRun events and exact retry identity when migrating 3→7', async () => {
  const c = oldProfile();
  let calls = 0;
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, usage: true, reasoning: false },
    async *stream() {
      calls++;
      yield { type: 'text_delta', text: 'Original M2 reply' };
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  const input = {
    workspaceId: 'ws_test',
    roomId: '0002',
    requestId: 'm2-send',
    text: 'M2 question',
    provider,
    signal: new AbortController().signal,
    emit: () => {},
  };
  c.db.exec('ALTER TABLE ocean_chat_turns ADD COLUMN review_id TEXT');
  const original = await c.chat.send(input);
  c.db.exec('ALTER TABLE ocean_chat_turns DROP COLUMN review_id');
  expect(original.ok).toBe(true);
  const tables = [
    'events',
    'command_receipts',
    'ocean_receipts',
    'ocean_chat_turns',
    'ocean_messages',
    'ocean_members',
  ];
  const snapshot = () =>
    tables.map((t) =>
      c.db
        .prepare(
          t === 'ocean_chat_turns'
            ? 'SELECT id,workspace_id,room_id,task_run_id,status,payload FROM ocean_chat_turns'
            : 'SELECT * FROM ' + t,
        )
        .all(),
    );
  const before = snapshot();
  const room = c.conversations.room('ws_test', '0002');
  initializeSchema(c.db);
  expect(c.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '11',
  );
  expect(snapshot()).toEqual(before);
  expect(c.db.prepare('SELECT review_id FROM ocean_chat_turns').get()?.['review_id']).toBeNull();
  expect(c.conversations.room('ws_test', '0002')).toEqual(room);
  expect(await c.chat.send(input)).toEqual(original);
  expect(calls).toBe(1);
  expect(c.db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
  expect(c.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  initializeSchema(c.db);
});
it('rolls back parent-table replacement on failure and restores FK enforcement', () => {
  const c = oldProfile();
  c.db.exec('CREATE TABLE ocean_messages_new(collision TEXT)');
  expect(() => initializeSchema(c.db)).toThrow();
  expect(c.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '3',
  );
  expect(
    c.db
      .prepare('PRAGMA table_info(ocean_rooms)')
      .all()
      .map((r) => r['name']),
  ).toEqual(['id', 'workspace_id', 'kind', 'bot_id']);
  expect(
    c.db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_rooms_new'").get(),
  ).toBeUndefined();
  expect(c.db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
  expect(c.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  c.db.exec('DROP TABLE ocean_messages_new');
  initializeSchema(c.db);
});
it('refuses migration of an owned M2 database before schema changes', () => {
  const c = oldProfile();
  c.db.exec('CREATE TABLE runtime_owner_v1(singleton INTEGER PRIMARY KEY,owner TEXT,pid INTEGER)');
  c.db.prepare('INSERT INTO runtime_owner_v1 VALUES(1,?,?)').run('owner', process.pid);
  expect(() => initializeSchema(c.db)).toThrow(/owner is live/);
  expect(c.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '3',
  );
  expect(c.db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
});
