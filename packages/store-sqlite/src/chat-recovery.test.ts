import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  ConversationService,
  DirectChatService,
  TaskRunService,
  type ModelRequest,
  type ProviderPort,
} from '@runnets/application';
import { SqliteConversationStore } from './conversations.js';
import { SqliteEventLog } from './event-log.js';
import { initializeSchema } from './schema.js';
import { createDurableIdGenerator } from './id-source.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const clock = { now: () => new Date('2026-11-02T00:00:00Z') };
function setup() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  databases.push(db);
  initializeSchema(db);
  const ids = createDurableIdGenerator(db);
  const tasks = new TaskRunService({ log: new SqliteEventLog(db, ids), ids, clock });
  const store = new SqliteConversationStore(db);
  let id = 0;
  const nextId = () => String(++id).padStart(4, '0');
  const conversations = new ConversationService({ store, clock, nextId });
  const chat = new DirectChatService({ store, tasks, clock, nextId });
  conversations.execute({
    type: 'BindWorkspace',
    requestId: 'init',
    workspaceId: 'ws_test',
    root: '/project',
  });
  conversations.execute({
    type: 'CreateBot',
    requestId: 'bot',
    workspaceId: 'ws_test',
    handle: 'dev',
    name: 'Dev',
    role: 'Role',
    provider: 'test',
    model: 'test',
  });
  conversations.execute({
    type: 'OpenDirectRoom',
    requestId: 'room',
    workspaceId: 'ws_test',
    botId: '0001',
  });
  return {
    db,
    store,
    tasks,
    conversations,
    chat,
    recover: () => new DirectChatService({ store, tasks, clock, nextId }).recover(),
  };
}
const base = {
  workspaceId: 'ws_test',
  roomId: '0002',
  requestId: 'first',
  text: 'hello',
  signal: new AbortController().signal,
  emit: () => {},
};
for (const failure of ['complete', 'publish']) {
  it(
    'recovers a full prepared response after ' + failure + ' fails without redispatch',
    async () => {
      const c = setup();
      let calls = 0;
      const text = 'Full response '.repeat(500);
      const provider: ProviderPort = {
        id: 'test',
        models: ['test'],
        capabilities: { streaming: true, reasoning: false, usage: true },
        async *stream() {
          calls++;
          yield { type: 'text_delta', text };
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
          yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        },
      };
      if (failure === 'complete')
        c.db.exec(
          "CREATE TRIGGER fail_final BEFORE INSERT ON events WHEN NEW.type='task_run.succeeded' BEGIN SELECT RAISE(ABORT,'final failed'); END",
        );
      else
        c.db.exec(
          "CREATE TRIGGER fail_final BEFORE INSERT ON ocean_messages WHEN NEW.author='bot' BEGIN SELECT RAISE(ABORT,'final failed'); END",
        );
      await expect(c.chat.send({ ...base, provider })).rejects.toThrow('final failed');
      expect(c.store.atomic((tx) => tx.chatTurns()[0]?.status)).toBe('prepared');
      c.db.exec('DROP TRIGGER fail_final');
      await c.recover();
      await c.recover();
      expect(calls).toBe(1);
      expect(await c.chat.send({ ...base, provider })).toMatchObject({
        ok: true,
        value: { status: 'completed', text },
      });
      const history = c.conversations.history('ws_test', '0002');
      expect(history).toMatchObject({
        ok: true,
        value: [{ author: 'user' }, { author: 'bot', body: text }],
      });
    },
  );
}
it('never promotes partial cancelled output into a bot answer or retries an unknown remote call', async () => {
  const c = setup();
  const controller = new AbortController();
  let calls = 0;
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream() {
      calls++;
      yield { type: 'text_delta', text: 'unfinished' };
      controller.abort();
    },
  };
  expect(await c.chat.send({ ...base, provider, signal: controller.signal })).toMatchObject({
    ok: true,
    value: { status: 'uncertain' },
  });
  await c.recover();
  expect(c.conversations.history('ws_test', '0002')).toMatchObject({
    ok: true,
    value: [{ author: 'user' }],
  });
  expect(await c.chat.send({ ...base, provider, requestId: 'another' })).toMatchObject({
    ok: false,
    error: { code: 'recovery_required' },
  });
  expect(calls).toBe(1);
});
it('builds the selected bot context without messages from another direct room', async () => {
  const c = setup();
  const requests: ModelRequest[] = [];
  const profile = c.conversations.execute({
    type: 'CreateBot',
    requestId: 'other',
    workspaceId: 'ws_test',
    handle: 'review',
    name: 'Review',
    role: 'Other',
    provider: 'test',
    model: 'test',
  });
  if (!profile.ok || profile.value.kind !== 'bot') throw Error('bot');
  const other = c.conversations.execute({
    type: 'OpenDirectRoom',
    requestId: 'other-room',
    workspaceId: 'ws_test',
    botId: profile.value.data.id,
  });
  if (!other.ok || other.value.kind !== 'room') throw Error('room');
  c.conversations.execute({
    type: 'RecordUserMessage',
    requestId: 'private',
    workspaceId: 'ws_test',
    roomId: other.value.data.id,
    text: 'private other room',
  });
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  await c.chat.send({ ...base, provider });
  expect(requests[0]?.messages).toEqual([
    { role: 'system', content: 'Role' },
    { role: 'user', content: 'hello' },
  ]);
});
