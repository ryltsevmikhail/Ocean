import { afterEach, expect, it } from 'vitest';
import {
  ConversationService,
  DirectChatService,
  ChatReviewService,
  TaskRunService,
  type ConversationStore,
  type ProviderPort,
  type ToolJournalPort,
} from '@runnets/application';
import {
  InMemoryConversationStore,
  InMemoryEventLog,
  InMemoryToolJournal,
  SequentialIdGenerator,
} from '@runnets/store';
import { openSqliteStore } from './index.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
const clock = { now: () => new Date('2026-11-02T00:00:00Z') };
function setup(store: ConversationStore, tasks: TaskRunService, journal: ToolJournalPort) {
  let id = 0;
  const nextId = () => String(++id).padStart(4, '0');
  const conversations = new ConversationService({ store, clock, nextId });
  const chat = new DirectChatService({ store, tasks, clock, nextId });
  const reviews = new ChatReviewService({ store, tasks, journal, clock, nextId });
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
  return { store, tasks, journal, chat, conversations, reviews };
}
const base = {
  workspaceId: 'ws_test',
  roomId: '0002',
  requestId: 'first',
  text: 'hello',
  signal: new AbortController().signal,
  emit: () => {},
};
const allow = { confirm: () => Promise.resolve(true) };
for (const adapter of ['memory', 'sqlite']) {
  function fixture() {
    if (adapter === 'memory')
      return setup(
        new InMemoryConversationStore(),
        new TaskRunService({
          log: new InMemoryEventLog(),
          clock,
          ids: new SequentialIdGenerator(),
        }),
        new InMemoryToolJournal(),
      );
    const db = openSqliteStore({ path: ':memory:' });
    cleanups.push(() => db.close());
    return setup(
      db.conversations,
      new TaskRunService({ log: db.log, clock, ids: new SequentialIdGenerator() }),
      db.tools,
    );
  }
  it(
    adapter +
      ': acknowledges an unknown outcome once, preserves task and global effect uncertainty and allows a fresh text-only turn',
    async () => {
      const c = fixture();
      let calls = 0;
      const broken: ProviderPort = {
        id: 'test',
        models: ['test'],
        capabilities: { streaming: true, usage: true, reasoning: false },
        async *stream() {
          calls++;
          yield { type: 'text_delta', text: 'partial' };
        },
      };
      const sent = await c.chat.send({ ...base, provider: broken });
      if (!sent.ok || sent.value.status === 'recorded') throw Error('turn');
      const id = sent.value.taskRunId;
      await c.journal.claim(
        'effect',
        'command',
        { taskRunId: id, attemptId: 'attempt' },
        'synthetic',
      );
      const snapshot = await c.reviews.review('ws_test', id);
      if (!snapshot.ok) throw Error('review');
      expect(snapshot.value).toMatchObject({
        canAcknowledge: true,
        turnStatus: 'uncertain',
        globalPendingEffects: 1,
      });
      const input = {
        workspaceId: 'ws_test',
        taskRunId: id,
        requestId: 'ack',
        reviewVersion: snapshot.value.version,
        reason: 'Inspected; continue text only',
      };
      expect(
        await c.reviews.acknowledge(input, { confirm: () => Promise.resolve(false) }, base.signal),
      ).toMatchObject({ ok: false, error: { code: 'approval_required' } });
      const original = await c.tasks.state(id as Parameters<typeof c.tasks.state>[0]);
      const ack = await c.reviews.acknowledge(input, allow, base.signal);
      expect(ack).toMatchObject({ ok: true, value: { mode: 'text_only' } });
      expect(
        await c.reviews.acknowledge(
          input,
          {
            confirm: () => {
              throw Error('retry must not prompt');
            },
          },
          base.signal,
        ),
      ).toEqual(ack);
      expect(await c.tasks.state(id as Parameters<typeof c.tasks.state>[0])).toEqual(original);
      expect(await c.journal.pending()).toHaveLength(1);
      expect(
        await c.journal.claim(
          'another',
          'command',
          { taskRunId: 'tr_other', attemptId: 'attempt' },
          'new',
        ),
      ).toBe(false);
      expect(c.conversations.history('ws_test', '0002')).toMatchObject({
        value: [{ body: 'hello' }, { body: expect.stringContaining('text-only') }],
      });
      const provider: ProviderPort = {
        ...broken,
        async *stream(request) {
          calls++;
          expect(request.tools).toBeUndefined();
          yield { type: 'text_delta', text: 'fresh reply' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        },
      };
      expect(await c.chat.send({ ...base, provider, requestId: 'next' })).toMatchObject({
        ok: true,
        value: { status: 'completed' },
      });
      expect(calls).toBe(2);
    },
  );
  it(
    adapter + ': rejects stale review evidence and cannot acknowledge an active dispatch',
    async () => {
      const c = fixture();
      const provider: ProviderPort = {
        id: 'test',
        models: ['test'],
        capabilities: { streaming: true, usage: true, reasoning: false },
        async *stream() {
          yield { type: 'text_delta', text: 'partial' };
        },
      };
      const sent = await c.chat.send({ ...base, provider });
      if (!sent.ok || sent.value.status === 'recorded') throw Error('turn');
      const snapshot = await c.reviews.review('ws_test', sent.value.taskRunId);
      if (!snapshot.ok) throw Error('review');
      await c.journal.claim(
        'later',
        'command',
        { taskRunId: sent.value.taskRunId, attemptId: 'attempt' },
        'later',
      );
      expect(
        await c.reviews.acknowledge(
          {
            workspaceId: 'ws_test',
            taskRunId: sent.value.taskRunId,
            requestId: 'ack',
            reviewVersion: snapshot.value.version,
            reason: 'Old observation',
          },
          allow,
          base.signal,
        ),
      ).toMatchObject({ ok: false, error: { code: 'review_conflict' } });
      expect(c.store.atomic((tx) => tx.activeChatTurn('0002'))?.status).toBe('uncertain');
    },
  );
}

it('refuses owner acknowledgement while the provider dispatch is still active', async () => {
  const c = setup(
    new InMemoryConversationStore(),
    new TaskRunService({
      log: new InMemoryEventLog(),
      clock,
      ids: new SequentialIdGenerator(),
    }),
    new InMemoryToolJournal(),
  );
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, usage: true, reasoning: false },
    async *stream() {
      entered();
      await wait;
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  const running = c.chat.send({ ...base, provider });
  await started;
  const turn = c.store.atomic((tx) => tx.chatTurns()[0]);
  if (turn === undefined) throw Error('turn');
  const review = await c.reviews.review('ws_test', turn.taskRunId);
  if (!review.ok) throw Error('review');
  expect(review.value.canAcknowledge).toBe(false);
  expect(
    await c.reviews.acknowledge(
      {
        workspaceId: 'ws_test',
        taskRunId: turn.taskRunId,
        requestId: 'ack',
        reviewVersion: review.value.version,
        reason: 'still running',
      },
      allow,
      base.signal,
    ),
  ).toMatchObject({ ok: false, error: { code: 'review_unavailable' } });
  release();
  await running;
});
