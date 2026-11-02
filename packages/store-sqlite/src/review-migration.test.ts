import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { SqliteConversationStore } from './conversations.js';
import { SqliteToolJournal } from './tool-journal.js';
import { initializeSchema } from './schema.js';
import type { ChatTurn } from '@runnets/domain';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function oldProfile() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  databases.push(db);
  db.exec(readFileSync(new URL('./fixtures/ocean-schema-v4.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO ocean_workspace VALUES(1,'ws_test','/project')");
  db.exec("INSERT INTO ocean_bots VALUES('bot','ws_test','dev','Dev','Role','test','test',1)");
  db.exec("INSERT INTO ocean_rooms VALUES('room','ws_test','direct','bot',NULL)");
  db.exec("INSERT INTO ocean_members VALUES('ws_test','room','bot')");
  db.exec(
    "INSERT INTO ocean_messages VALUES('message','ws_test','room',1,'user','bot','original input','2026-11-02T00:00:00Z',NULL,NULL)",
  );
  const turn: ChatTurn = {
    id: 'turn',
    workspaceId: 'ws_test',
    roomId: 'room',
    requestId: 'request',
    taskRunId: 'tr_old',
    inboundMessageId: 'message',
    readThroughSeq: 1,
    bot: {
      id: 'bot',
      workspaceId: 'ws_test',
      handle: 'dev',
      name: 'Dev',
      role: 'Role',
      provider: 'test',
      model: 'test',
      profileVersion: 1,
    },
    status: 'uncertain',
    text: '',
    preparedVersion: null,
    stopReason: 'end_turn',
  };
  db.prepare('INSERT INTO ocean_chat_turns VALUES(?,?,?,?,?,?)').run(
    turn.id,
    turn.workspaceId,
    turn.roomId,
    turn.taskRunId,
    turn.status,
    JSON.stringify(turn),
  );
  return { db, turn, journal: new SqliteToolJournal(db) };
}
it('migrates M3 uncertainty without releasing any hold or tool claim', async () => {
  const { db, turn, journal } = oldProfile();
  await journal.claim(
    'effect',
    'command',
    { taskRunId: turn.taskRunId, attemptId: 'attempt' },
    'synthetic',
  );
  const before = await journal.pending();
  const payload = db.prepare('SELECT payload FROM ocean_chat_turns').get();
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '5',
  );
  expect(db.prepare('SELECT payload FROM ocean_chat_turns').get()).toEqual(payload);
  expect(await journal.pending()).toEqual(before);
  const store = new SqliteConversationStore(db);
  expect(store.atomic((tx) => tx.activeChatTurn('room'))).toEqual(turn);
  expect(store.atomic((tx) => tx.roomPolicy('room'))).toBeNull();
  expect(db.prepare('SELECT * FROM ocean_reviews').all()).toEqual([]);
  expect(() =>
    store.atomic((tx) => tx.putChatTurn({ ...turn, id: 'another', taskRunId: 'tr_another' })),
  ).toThrow();
  expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
});
it('rolls back new review tables and columns if the audit migration cannot finish', () => {
  const { db } = oldProfile();
  db.exec('CREATE TABLE ocean_room_policies(collision TEXT)');
  expect(() => initializeSchema(db)).toThrow();
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '4',
  );
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_reviews'").get(),
  ).toBeUndefined();
  expect(
    db
      .prepare('PRAGMA table_info(ocean_chat_turns)')
      .all()
      .some((row) => row['name'] === 'review_id'),
  ).toBe(false);
  expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
  db.exec('DROP TABLE ocean_room_policies');
  initializeSchema(db);
});
