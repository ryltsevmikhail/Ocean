import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import {
  ConversationService,
  DirectChatService,
  ChatReviewService,
  TaskRunService,
  type ProviderPort,
} from '@runnets/application';
import { SqliteConversationStore } from './conversations.js';
import { SqliteEventLog } from './event-log.js';
import { SqliteToolJournal } from './tool-journal.js';
import { createDurableIdGenerator } from './id-source.js';
import { initializeSchema } from './schema.js';
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
async function setup() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  dbs.push(db);
  initializeSchema(db);
  const store = new SqliteConversationStore(db);
  const journal = new SqliteToolJournal(db);
  const clock = { now: () => new Date('2026-11-02T00:00:00Z') };
  const ids = createDurableIdGenerator(db);
  const tasks = new TaskRunService({ log: new SqliteEventLog(db, ids), clock, ids });
  let id = 0;
  const nextId = () => String(++id).padStart(4, '0');
  const conversations = new ConversationService({ store, clock, nextId });
  const chat = new DirectChatService({ store, clock, nextId, tasks });
  const reviews = new ChatReviewService({ store, clock, nextId, tasks, journal });
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
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, usage: true, reasoning: false },
    async *stream() {
      yield { type: 'text_delta', text: 'partial' };
    },
  };
  const sent = await chat.send({
    workspaceId: 'ws_test',
    roomId: '0002',
    requestId: 'send',
    text: 'hello',
    provider,
    signal: new AbortController().signal,
    emit: () => {},
  });
  if (!sent.ok || sent.value.status === 'recorded') throw Error('turn');
  const snapshot = await reviews.review('ws_test', sent.value.taskRunId);
  if (!snapshot.ok) throw Error('snapshot');
  const input = {
    workspaceId: 'ws_test',
    taskRunId: sent.value.taskRunId,
    requestId: 'ack',
    reviewVersion: snapshot.value.version,
    reason: 'Reviewed',
  };
  return { db, store, tasks, journal, conversations, reviews, input };
}
const signal = new AbortController().signal;
const allow = { confirm: () => Promise.resolve(true) };
it('rolls back notice, room policy, review marker and receipt if audit storage fails', async () => {
  const c = await setup();
  c.db.exec(
    "CREATE TRIGGER reject_review BEFORE INSERT ON ocean_reviews BEGIN SELECT RAISE(ABORT,'audit failed'); END",
  );
  await expect(c.reviews.acknowledge(c.input, allow, signal)).rejects.toThrow('audit failed');
  expect(c.conversations.history('ws_test', '0002')).toMatchObject({ value: [{ body: 'hello' }] });
  expect(c.store.atomic((tx) => tx.roomPolicy('0002'))).toBeNull();
  expect(c.store.atomic((tx) => tx.activeChatTurn('0002'))?.continuationReviewId).toBeUndefined();
  expect(c.store.atomic((tx) => tx.receipt('ack'))).toBeNull();
  c.db.exec('DROP TRIGGER reject_review');
  expect((await c.reviews.acknowledge(c.input, allow, signal)).ok).toBe(true);
  expect(c.conversations.history('ws_test', '0002')).toMatchObject({
    value: [{ seq: 1 }, { seq: 2 }],
  });
});
it('compares journal evidence again after owner confirmation', async () => {
  const c = await setup();
  const result = await c.reviews.acknowledge(
    c.input,
    {
      async confirm() {
        await c.journal.claim(
          'later',
          'command',
          { taskRunId: c.input.taskRunId, attemptId: 'attempt' },
          'request',
        );
        return true;
      },
    },
    signal,
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'review_conflict' } });
  expect(c.store.atomic((tx) => tx.activeChatTurn('0002'))).not.toBeNull();
});
it('keeps reviewed uncertainty immutable and rejects late reattachment to the room hold', async () => {
  const c = await setup();
  await c.reviews.acknowledge(c.input, allow, signal);
  const turn = c.store.atomic((tx) => tx.chatTurns()[0]);
  if (turn === undefined) throw Error('turn');
  const { continuationReviewId: _review, ...old } = turn;
  expect(() => c.store.atomic((tx) => tx.putChatTurn(old))).toThrow(
    'continuation review is immutable',
  );
  expect(c.store.atomic((tx) => tx.chatTurn(turn.id))).toMatchObject({
    status: 'uncertain',
    continuationReviewId: turn.continuationReviewId,
  });
});
