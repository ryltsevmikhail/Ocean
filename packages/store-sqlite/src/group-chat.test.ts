import { afterEach, expect, it } from 'vitest';
import {
  ConversationService,
  DirectChatService,
  TaskRunService,
  type ConversationStore,
  type ModelRequest,
  type ProviderPort,
} from '@runnets/application';
import { InMemoryConversationStore, InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import { openSqliteStore } from './index.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const clock = { now: () => new Date('2026-11-02T00:00:00Z') };
function setup(store: ConversationStore) {
  let id = 0;
  const nextId = () => String(++id).padStart(4, '0');
  const conversations = new ConversationService({ store, clock, nextId });
  const tasks = new TaskRunService({
    log: new InMemoryEventLog(),
    clock,
    ids: new SequentialIdGenerator(),
  });
  const chat = new DirectChatService({ store, clock, nextId, tasks });
  conversations.execute({
    type: 'BindWorkspace',
    requestId: 'init',
    workspaceId: 'ws_test',
    root: '/project',
  });
  for (const handle of ['dev', 'review', 'outsider'])
    conversations.execute({
      type: 'CreateBot',
      requestId: handle,
      workspaceId: 'ws_test',
      handle,
      name: handle.toUpperCase(),
      role: 'Role ' + handle,
      provider: 'test',
      model: 'test',
    });
  const bots = conversations.bots('ws_test');
  if (!bots.ok) throw Error('bots');
  const botIds = bots.value.filter((b) => b.handle !== 'outsider').map((b) => b.id);
  const group = {
    type: 'CreateGroupRoom',
    requestId: 'group',
    workspaceId: 'ws_test',
    title: 'Team',
    botIds,
  } as const;
  const created = conversations.execute(group);
  if (!created.ok || created.value.kind !== 'room') throw Error('group creation failed');
  const requests: ModelRequest[] = [];
  const provider: ProviderPort = {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, usage: true, reasoning: false },
    async *stream(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'Answer @review without automatic dispatch' };
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  const send = {
    workspaceId: 'ws_test',
    roomId: created.value.data.id,
    requestId: 'first',
    text: 'Implement add',
    signal: new AbortController().signal,
    emit: () => {},
    provider,
  };
  return { conversations, chat, tasks, group, requests, send };
}
for (const adapter of ['memory', 'sqlite']) {
  function fixture() {
    if (adapter === 'memory') return setup(new InMemoryConversationStore());
    const db = openSqliteStore({ path: ':memory:' });
    cleanups.push(() => db.close());
    return setup(db.conversations);
  }
  it(
    adapter +
      ': records shared notes without dispatch and explicitly hands work from developer to reviewer',
    async () => {
      const c = fixture();
      expect(c.conversations.execute(c.group)).toMatchObject({
        ok: true,
        value: { data: { kind: 'group', title: 'Team' } },
      });
      const note = { ...c.send, text: 'Shared context', provider: null };
      expect(await c.chat.send(note)).toMatchObject({
        ok: true,
        value: { status: 'recorded', taskRunId: null },
      });
      expect(await c.chat.send(note)).toMatchObject({ ok: true, value: { status: 'recorded' } });
      expect(c.requests).toHaveLength(0);
      expect(await c.tasks.listTaskRuns()).toHaveLength(0);
      expect(await c.chat.send({ ...c.send, requestId: 'dev-turn', to: 'dev' })).toMatchObject({
        ok: true,
        value: { status: 'completed', bot: { handle: 'dev' } },
      });
      expect(c.requests).toHaveLength(1);
      expect(
        await c.chat.send({
          ...c.send,
          requestId: 'review-turn',
          text: '@review check the result',
        }),
      ).toMatchObject({ ok: true, value: { status: 'completed', bot: { handle: 'review' } } });
      expect(c.requests).toHaveLength(2);
      expect(c.requests[1]?.messages).toContainEqual({
        role: 'user',
        content: JSON.stringify({
          author: { kind: 'bot', id: c.group.botIds[0], handle: 'dev', name: 'DEV' },
          text: 'Answer @review without automatic dispatch',
        }),
      });
      expect(c.requests[1]?.messages.some((m) => m.role === 'assistant')).toBe(false);
      expect(c.conversations.history('ws_test', c.send.roomId)).toMatchObject({
        value: [
          { seq: 1, targetBotId: null },
          { seq: 2 },
          { seq: 3, author: 'bot' },
          { seq: 4 },
          { seq: 5, author: 'bot' },
        ],
      });
      expect(await c.tasks.listTaskRuns()).toHaveLength(2);
    },
  );
  it(
    adapter + ': rejects invalid membership, ambiguous targets and changed retries without effects',
    async () => {
      const c = fixture();
      for (const change of [
        { text: '@dev @review both' },
        { text: '@dev hi', to: 'review' },
        { to: 'outsider' },
        { to: 'missing' },
      ])
        expect((await c.chat.send({ ...c.send, ...change })).ok).toBe(false);
      expect(c.requests).toHaveLength(0);
      expect(c.conversations.history('ws_test', c.send.roomId)).toMatchObject({ value: [] });
      await c.chat.send({ ...c.send, to: 'dev' });
      expect(await c.chat.send({ ...c.send, to: 'review' })).toMatchObject({
        ok: false,
        error: { code: 'request_conflict' },
      });
      expect(
        c.conversations.execute({
          ...c.group,
          requestId: 'bad-group',
          botIds: [c.group.botIds[0] ?? 'missing'],
        }),
      ).toMatchObject({ ok: false });
      expect(
        c.conversations.execute({
          ...c.group,
          requestId: 'duplicate',
          botIds: [...c.group.botIds, c.group.botIds[0] ?? 'missing'],
        }),
      ).toMatchObject({ ok: false });
    },
  );
  it(
    adapter +
      ': freezes each addressed context and rejects another active turn while allowing shared notes',
    async () => {
      const c = fixture();
      let entered: () => void = () => {};
      let release: () => void = () => {};
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const waiting = new Promise<void>((r) => {
        release = r;
      });
      const provider: ProviderPort = {
        ...c.send.provider,
        async *stream(request) {
          c.requests.push(request);
          entered();
          await waiting;
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        },
      };
      const first = c.chat.send({ ...c.send, to: 'dev', provider });
      await started;
      expect(
        await c.chat.send({ ...c.send, to: 'review', provider, requestId: 'busy' }),
      ).toMatchObject({ ok: false, error: { code: 'room_busy' } });
      expect(
        await c.chat.send({
          ...c.send,
          provider: null,
          requestId: 'note',
          text: 'Arrived during dispatch',
        }),
      ).toMatchObject({ ok: true, value: { status: 'recorded' } });
      expect(JSON.stringify(c.requests[0]?.messages)).not.toContain('Arrived during dispatch');
      release();
      await first;
      await c.chat.send({ ...c.send, to: 'review', provider, requestId: 'next' });
      expect(JSON.stringify(c.requests[1]?.messages)).toContain('Arrived during dispatch');
      expect(await c.tasks.listTaskRuns()).toHaveLength(2);
    },
  );
}
