import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { RoomBroadcastService, type ProviderPort } from '@runnets/application';
import { systemClock } from '@runnets/store';
import type { BroadcastBatch, ChatTurn } from '@runnets/domain';
import { openOceanProfile } from '../ocean/profile.js';
import { startBroadcastHost } from '../../test-fixtures/broadcast-host.test.js';
import { broadcastProfile } from '../../test-fixtures/broadcast-host.test.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(condition: () => boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('timeout: ' + label);
    await sleep(25);
  }
}
async function seedPausedBatch(profile: string, roomId: string, requestId: string) {
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const store = runtime.conversationStore;
  if (!store) throw Error('store');
  const service = new RoomBroadcastService({
    store,
    clock: systemClock,
    nextId: () => randomUUID().replaceAll('-', ''),
  });
  const submitted = service.submit({
    workspaceId: 'ws_ocean',
    roomId,
    requestId,
    text: 'Вопрос обоим участникам',
  });
  if (!submitted.ok) throw Error('submit: ' + submitted.error.code);
  const batch = submitted.value;
  const turns = store.atomic((tx) => tx.broadcastTurns(batch.id));
  const first = turns[0];
  const second = turns[1];
  if (!first || !second) throw Error('two children');
  store.atomic((tx) => {
    tx.putChatTurn({ ...first, status: 'completed' });
    tx.putMessage({
      id: 'reply_' + first.id,
      workspaceId: 'ws_ocean',
      roomId,
      seq: tx.nextSequence(roomId),
      author: 'bot',
      authorBotId: first.bot.id,
      turnId: first.id,
      targetBotId: first.bot.id,
      body: 'Ответ первого участника',
      createdAt: '2026-11-04T00:00:00.000Z',
    });
    const stored: BroadcastBatch = tx.broadcastBatch(batch.id)!;
    tx.putBroadcastBatch({ ...stored, state: 'paused', revision: 2 });
  });
  runtime.close();
  return { batchId: batch.id, firstTurnId: first.id, secondTurnId: second.id };
}
function countingProvider(calls: ChatTurn[]): ProviderPort {
  return {
    id: 'deepseek',
    models: ['deepseek-flash'],
    capabilities: { streaming: true, reasoning: false, usage: true },
    async *stream(request) {
      calls.push(request as unknown as ChatTurn);
      yield { type: 'text_delta', text: 'Ответ второго участника' };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
}
it('continues a paused batch and dispatches only never-started children', async () => {
  const profile = await broadcastProfile();
  cleanups.push(() => profile.dispose());
  const seeded = await seedPausedBatch(profile.profile, profile.roomId, 'broadcast-1');
  const calls: ChatTurn[] = [];
  const started = await startBroadcastHost(profile, '', countingProvider(calls));
  cleanups.push(() => started.stop());
  const paused = await started.client.broadcastGet({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    batchId: seeded.batchId,
  });
  expect(paused).toMatchObject({ state: 'paused', revision: 2 });
  expect(paused.recipients.map((child) => child.state)).toEqual(['answered', 'queued']);
  // The paused batch still blocks new model turns.
  await expect(
    started.client.submit({
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      requestId: 'blocked-turn',
      text: 'Новый вопрос',
      to: 'dev',
    }),
  ).rejects.toThrow('batch_open');
  const continued = await started.client.broadcastContinue({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    batchId: seeded.batchId,
    expectedRevision: 2,
  });
  expect(continued).toMatchObject({ state: 'open', revision: 3 });
  await until(() => calls.length === 1, 'continued child dispatched');
  // Wait for durable completion by reading the authoritative DTO.
  let settled = continued;
  for (let attempt = 0; attempt < 800 && settled.state === 'open'; attempt++) {
    await sleep(25);
    settled = await started.client.broadcastGet({
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      batchId: seeded.batchId,
    });
  }
  expect(settled.state).toBe('completed');
  expect(calls).toHaveLength(1);
  expect(
    (calls[0] as unknown as { messages: { content: string }[] }).messages.at(-1)?.content,
  ).toBe('Вопрос обоим участникам');
  const final = await started.client.broadcastGet({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    batchId: seeded.batchId,
  });
  expect(final).toMatchObject({ state: 'completed' });
  expect(final.recipients.map((child) => child.state)).toEqual(['answered', 'answered']);
  const history = await started.client.history({
    workspaceId: 'ws_ocean',
    roomId: profile.roomId,
    after: 0,
    limit: 50,
  });
  expect(history.filter((message) => message.author === 'user')).toHaveLength(1);
  expect(history.filter((message) => message.author === 'bot')).toHaveLength(2);
});
