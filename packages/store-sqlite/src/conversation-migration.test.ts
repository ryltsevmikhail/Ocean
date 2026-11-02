import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ConversationService, TaskRunService } from '@runnets/application';
import {
  conversationId,
  taskRunId,
  workspaceId,
  unlimitedBudget,
  type AnyCommand,
} from '@runnets/domain';
import { initializeSchema } from './schema.js';
import { SqliteConversationStore } from './conversations.js';
import { SqliteEventLog } from './event-log.js';
import { CONVERSATION_TABLES } from './conversation-schema.js';
import { createDurableIdGenerator } from './id-source.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const clock = { now: () => new Date('2026-11-02T00:00:00.000Z') };
const bind = {
  type: 'BindWorkspace',
  requestId: 'init',
  workspaceId: 'w',
  root: '/project',
} as const;
const bot = {
  type: 'CreateBot',
  requestId: 'bot',
  workspaceId: 'w',
  handle: 'dev',
  name: 'Dev',
  role: 'Developer',
  provider: 'deepseek',
  model: 'test',
} as const;

function setup() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  databases.push(db);
  initializeSchema(db);
  let id = 0;
  const service = new ConversationService({
    store: new SqliteConversationStore(db),
    clock,
    nextId: () => 'id_' + String(++id),
  });
  return { db, service };
}
/** Remove only new tables to recreate the original v1 tables with their exact runtime records. */
function downgradeFixture(db: DatabaseSync) {
  db.exec('DROP TRIGGER ocean_direct_member');
  for (const table of [...CONVERSATION_TABLES].reverse()) db.exec('DROP TABLE ' + table);
  db.exec("UPDATE meta SET value='1' WHERE key='schema_version'");
}
const create: AnyCommand = {
  type: 'CreateTaskRun',
  commandId: 'cm_old',
  taskRunId: taskRunId('tr_old'),
  expectedVersion: 0,
  actor: { kind: 'user', id: 'user' },
  payload: {
    conversationId: conversationId('cv_old'),
    workspaceId: workspaceId('ws_old'),
    parentTaskRunId: null,
    model: 'old-model',
    policyId: 'pl_old',
    budget: unlimitedBudget(),
  },
};
it('migrates v1 without changing task events, receipts, checkpoints or unknown tool claims', async () => {
  const { db } = setup();
  const ids = createDurableIdGenerator(db);
  const log = new SqliteEventLog(db, ids);
  const tasks = new TaskRunService({ log, clock, ids });
  const receipt = await tasks.execute(create);
  expect(receipt.ok).toBe(true);
  const stream = await log.load(create.taskRunId);
  db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run(
    create.taskRunId,
    1,
    1,
    JSON.stringify(stream),
  );
  db.exec('CREATE TABLE tool_invocations_v1(id TEXT PRIMARY KEY, tool TEXT, outcome TEXT)');
  db.exec("INSERT INTO tool_invocations_v1 VALUES('old','command','uncertain')");
  downgradeFixture(db);
  const before = ['events', 'command_receipts', 'checkpoints', 'tool_invocations_v1'].map((t) =>
    db.prepare('SELECT * FROM ' + t).all(),
  );
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '2',
  );
  expect(
    ['events', 'command_receipts', 'checkpoints', 'tool_invocations_v1'].map((t) =>
      db.prepare('SELECT * FROM ' + t).all(),
    ),
  ).toEqual(before);
  expect(await log.load(create.taskRunId)).toEqual(stream);
  expect(await tasks.execute(create)).toEqual(receipt);
  expect(db.prepare('SELECT * FROM ocean_rooms').all()).toEqual([]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  initializeSchema(db);
});
it('rolls back an interrupted migration before version advancement, then allows retry', () => {
  const { db } = setup();
  downgradeFixture(db);
  db.exec('CREATE TABLE ocean_messages(collision TEXT)');
  expect(() => initializeSchema(db)).toThrow();
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '1',
  );
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_bots'").get(),
  ).toBeUndefined();
  db.exec('DROP TABLE ocean_messages');
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '2',
  );
});
it('refuses schema migration beneath a live runtime owner without changing the database', () => {
  const { db } = setup();
  downgradeFixture(db);
  db.exec('CREATE TABLE runtime_owner_v1(singleton INTEGER PRIMARY KEY, owner TEXT, pid INTEGER)');
  db.prepare('INSERT INTO runtime_owner_v1 VALUES(1,?,?)').run('test-owner', process.pid);
  expect(() => initializeSchema(db)).toThrow(/owner is live/);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '1',
  );
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='ocean_workspace'").get(),
  ).toBeUndefined();
});
it('rolls back bot and message writes if the same-transaction receipt cannot commit', () => {
  const { db, service } = setup();
  service.execute(bind);
  db.exec(
    "CREATE TRIGGER reject_ocean_receipt BEFORE INSERT ON ocean_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
  );
  expect(() => service.execute(bot)).toThrow('receipt failure');
  expect(service.bots('w')).toEqual({ ok: true, value: [] });
  db.exec('DROP TRIGGER reject_ocean_receipt');
  const result = service.execute(bot);
  if (!result.ok || result.value.kind !== 'bot') throw new Error('expected bot');
  const opened = service.execute({
    type: 'OpenDirectRoom',
    requestId: 'room',
    workspaceId: 'w',
    botId: result.value.data.id,
  });
  if (!opened.ok || opened.value.kind !== 'room') throw new Error('expected room');
  const roomId = opened.value.data.id;
  db.exec(
    "CREATE TRIGGER reject_message_receipt BEFORE INSERT ON ocean_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
  );
  const message = {
    type: 'RecordUserMessage',
    requestId: 'msg',
    workspaceId: 'w',
    roomId,
    text: 'Hi',
  } as const;
  expect(() => service.execute(message)).toThrow('receipt failure');
  expect(service.history('w', roomId)).toEqual({ ok: true, value: [] });
  db.exec('DROP TRIGGER reject_message_receipt');
  expect(service.execute(message)).toMatchObject({ ok: true, value: { data: { seq: 1 } } });
});
it('enforces foreign keys and room membership even on direct database writes', () => {
  const { db, service } = setup();
  service.execute(bind);
  service.execute(bot);
  service.execute({ type: 'OpenDirectRoom', requestId: 'room', workspaceId: 'w', botId: 'id_1' });
  expect(() =>
    db
      .prepare('INSERT INTO ocean_messages VALUES(?,?,?,?,?,?,?,?)')
      .run('m', 'w', 'id_2', 1, 'user', 'missing', 'text', 'now'),
  ).toThrow();
  expect(() =>
    db
      .prepare('INSERT INTO ocean_bots VALUES(?,?,?,?,?,?,?,?)')
      .run('b', 'foreign', 'b', 'b', 'b', 'b', 'b', 1),
  ).toThrow();
});
