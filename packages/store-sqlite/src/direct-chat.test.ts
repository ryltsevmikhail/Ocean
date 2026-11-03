import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationService,
  DirectChatService,
  TaskRunService,
  type ModelRequest,
  type ProviderPort,
} from '@runnets/application';
import { openSqliteStore, type SqliteStore } from './index.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const clock = { now: () => new Date('2026-11-02T00:00:00.000Z') };
let identity = 0;
const nextId = () => 'chat' + String(++identity);
function context(store: SqliteStore) {
  const tasks = new TaskRunService({
    log: store.log,
    clock,
    ids: { eventId: nextId, commandId: nextId },
  });
  const conversations = new ConversationService({ store: store.conversations, clock, nextId });
  const chat = new DirectChatService({ store: store.conversations, tasks, clock, nextId });
  return { tasks, conversations, chat };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ocean-m2-'));
  const path = join(dir, 'runtime.sqlite');
  let store = openSqliteStore({ path });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = context(store);
  c.conversations.execute({
    type: 'BindWorkspace',
    requestId: 'init',
    workspaceId: 'ws_test',
    root: '/project',
  });
  const b = c.conversations.execute({
    type: 'CreateBot',
    requestId: 'bot',
    workspaceId: 'ws_test',
    handle: 'dev',
    name: 'Developer',
    role: 'You are a developer.',
    provider: 'test',
    model: 'test',
  });
  if (!b.ok || b.value.kind !== 'bot') throw Error('bot');
  const r = c.conversations.execute({
    type: 'OpenDirectRoom',
    requestId: 'room',
    workspaceId: 'ws_test',
    botId: b.value.data.id,
  });
  if (!r.ok || r.value.kind !== 'room') throw Error('room');
  return {
    ...c,
    roomId: r.value.data.id,
    store,
    reopen: () => {
      store.close();
      store = openSqliteStore({ path });
      return context(store);
    },
  };
}
function provider(requests: ModelRequest[], text = 'Remembered'): ProviderPort {
  return {
    id: 'test',
    models: ['test'],
    capabilities: { streaming: true, reasoning: true, usage: true },
    async *stream(request) {
      requests.push(request);
      yield { type: 'reasoning_delta', text: 'private reasoning' };
      yield { type: 'text_delta', text };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
}
const input = {
  workspaceId: 'ws_test',
  requestId: 'first',
  text: 'The function is add.',
  signal: new AbortController().signal,
  emit: () => {},
};
it('restores model context and full replies after reopen without reasoning or a second dispatch on retry', async () => {
  const c = setup();
  const requests: ModelRequest[] = [];
  const send = { ...input, roomId: c.roomId, provider: provider(requests, 'x'.repeat(3000)) };
  const first = await c.chat.send(send);
  expect(first).toMatchObject({ ok: true, value: { status: 'completed', text: 'x'.repeat(3000) } });
  const restarted = c.reopen();
  await restarted.chat.recover();
  expect(await restarted.chat.send(send)).toEqual(first);
  expect(requests).toHaveLength(1);
  const second = await restarted.chat.send({
    ...send,
    requestId: 'second',
    text: 'What function did I mention?',
  });
  expect(second.ok).toBe(true);
  expect(requests[1]?.messages).toEqual([
    { role: 'system', content: 'You are a developer.' },
    { role: 'user', content: input.text },
    { role: 'assistant', content: 'x'.repeat(3000) },
    { role: 'user', content: 'What function did I mention?' },
  ]);
  expect(restarted.conversations.history('ws_test', c.roomId)).toMatchObject({
    value: [
      { author: 'user', seq: 1 },
      { author: 'bot', seq: 2 },
      { author: 'user', seq: 3 },
      { author: 'bot', seq: 4 },
    ],
  });
});
it('rejects a changed retry and missing provider before new input is committed', async () => {
  const c = setup();
  const requests: ModelRequest[] = [];
  const send = { ...input, roomId: c.roomId, provider: provider(requests) };
  await c.chat.send(send);
  expect(await c.chat.send({ ...send, text: 'changed' })).toMatchObject({
    ok: false,
    error: { code: 'request_conflict' },
  });
  expect(await c.chat.send({ ...send, requestId: 'offline', provider: null })).toMatchObject({
    ok: false,
    error: { code: 'provider_unavailable' },
  });
  expect(c.conversations.history('ws_test', c.roomId)).toMatchObject({
    value: [{ seq: 1 }, { seq: 2 }],
  });
  expect(requests).toHaveLength(1);
});
it('blocks overlapping turns and interrupted dispatch without replay', async () => {
  const c = setup();
  let started: () => void = () => {};
  const entered = new Promise<void>((r) => {
    started = r;
  });
  let finish: () => void = () => {};
  const wait = new Promise<void>((r) => {
    finish = r;
  });
  const p: ProviderPort = {
    ...provider([]),
    async *stream() {
      started();
      await wait;
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
  const send = { ...input, roomId: c.roomId, provider: p };
  const running = c.chat.send(send);
  await entered;
  expect(await c.chat.send({ ...send, requestId: 'other' })).toMatchObject({
    ok: false,
    error: { code: 'room_busy' },
  });
  expect(await c.chat.send(send)).toMatchObject({ ok: true, value: { status: 'dispatching' } });
  finish();
  await running;
  const reopened = c.reopen();
  await reopened.chat.recover();
  expect(await reopened.chat.send({ ...send, requestId: 'third' })).toMatchObject({
    ok: false,
    error: { code: 'recovery_required' },
  });
});

it('cancels a fresh chat before dispatch with a confirmed terminal task and no model call', async () => {
  const c = setup();
  const requests: ModelRequest[] = [];
  const controller = new AbortController();
  controller.abort();
  const result = await c.chat.send({
    ...input,
    roomId: c.roomId,
    provider: provider(requests),
    signal: controller.signal,
  });
  expect(result).toMatchObject({ ok: true, value: { status: 'cancelled' } });
  expect(requests).toHaveLength(0);
  const ids = await c.tasks.listTaskRuns();
  expect(ids).toHaveLength(1);
  const id = ids[0];
  if (id === undefined) throw Error('missing task');
  expect(await c.tasks.state(id)).toMatchObject({ status: 'cancelled' });
});
it('refuses an oversized restored context before saving a new prompt or invoking the model', async () => {
  const c = setup();
  const requests: ModelRequest[] = [];
  for (let n = 0; n < 4; n++)
    c.conversations.execute({
      type: 'RecordUserMessage',
      requestId: 'large' + String(n),
      workspaceId: 'ws_test',
      roomId: c.roomId,
      text: 'x'.repeat(16384),
    });
  expect(
    await c.chat.send({ ...input, roomId: c.roomId, provider: provider(requests) }),
  ).toMatchObject({ ok: false, error: { code: 'context_limit' } });
  expect(requests).toHaveLength(0);
  expect(c.conversations.history('ws_test', c.roomId)).toMatchObject({
    ok: true,
    value: Array.from({ length: 4 }, () => ({ author: 'user' })),
  });
});

it('requires an injected task factory and binds task identity into the durable chat receipt', async () => {
  const c = setup(),
    requests: ModelRequest[] = [];
  const send = { ...input, roomId: c.roomId, provider: provider(requests), taskId: 'task' };
  expect(await c.chat.send(send)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  expect(requests).toHaveLength(0);
  const seen: string[] = [];
  const chat = new DirectChatService({
    store: c.store.conversations,
    tasks: c.tasks,
    clock,
    nextId,
    codingTools: {
      forTurn: async (turn) => {
        seen.push(turn.codingTaskId!);
        return {
          instructions: 'Task-scoped coding instructions',
          cleanupConfirmed: true as const,
          definitions: [],
          execute: async () => ({ isError: true, output: 'unused' }),
        };
      },
    },
  });
  expect(await chat.send(send)).toMatchObject({
    ok: true,
    value: { status: 'completed', codingTaskId: 'task' },
  });
  expect(seen).toEqual(['task']);
  expect(requests[0]?.messages[0]).toEqual({
    role: 'system',
    content: 'Task-scoped coding instructions',
  });
  expect(await chat.send({ ...send, taskId: 'different' })).toMatchObject({
    ok: false,
    error: { code: 'request_conflict' },
  });
  // Observation survives a host without the coding factory that admitted this task.
  expect(await c.chat.send({ ...send, provider: null })).toMatchObject({
    ok: true,
    value: { status: 'completed', codingTaskId: 'task' },
  });
  expect(await c.chat.send({ ...send, taskId: 'different' })).toMatchObject({
    ok: false,
    error: { code: 'request_conflict' },
  });
  expect(requests).toHaveLength(1);
});
