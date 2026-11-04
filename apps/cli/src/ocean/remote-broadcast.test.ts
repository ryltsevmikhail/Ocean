import { expect, it } from 'vitest';
import type { LocalBroadcastBatch } from '@runnets/contracts';
import type { RoomConnection } from './room-connection.js';
import { RemoteBroadcast } from './remote-broadcast.js';

const batch = {
  version: 1,
  id: 'batch_1',
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  requestId: 'request_1',
  messageId: 'message_1',
  boundarySeq: 1,
  recipients: [
    {
      botId: 'bot_1',
      handle: 'dev',
      name: 'Dev',
      provider: 'deepseek',
      model: 'deepseek-flash',
      turnId: 'turn_1',
      runId: 'tr_turn_1',
      position: 0,
      state: 'answered',
      resultMessageId: 'reply_turn_1',
    },
    {
      botId: 'bot_2',
      handle: 'review',
      name: 'Review',
      provider: 'deepseek',
      model: 'deepseek-flash',
      turnId: 'turn_2',
      runId: 'tr_turn_2',
      position: 1,
      state: 'uncertain',
      resultMessageId: null,
    },
  ],
  state: 'paused',
  revision: 2,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:01.000Z',
} as unknown as LocalBroadcastBatch;
function fakeConnection(client: Record<string, (...args: never[]) => Promise<unknown>>) {
  return {
    withClient: (operation: (c: unknown) => Promise<unknown>) => operation(client),
  } as unknown as RoomConnection;
}
it('shows the durable batch and keeps the same request id after a lost reply', async () => {
  const submitted: { requestId?: string; text?: string }[] = [];
  let failNext = true;
  const client = {
    broadcastList: async () => [batch],
    broadcastSubmit: async (input: unknown) => {
      submitted.push(input as { requestId: string; text: string });
      if (failNext) {
        failNext = false;
        throw Error('connection_closed');
      }
      return batch;
    },
    broadcastContinue: async () => ({ ...batch, state: 'open', revision: 3 }),
    broadcastAbandon: async () => ({ ...batch, state: 'abandoned', revision: 3 }),
  };
  const remote = new RemoteBroadcast(fakeConnection(client), {
    workspaceId: 'ws_ocean',
    roomId: 'room_1',
  });
  await remote.refresh();
  expect(remote.status()).toContain('всем paused v2');
  expect(remote.status()).toContain('@dev:answered');
  expect(remote.status()).toContain('@review:uncertain');
  await expect(remote.submit('вопрос')).rejects.toThrow('connection_closed');
  await remote.submit('вопрос');
  expect(submitted).toHaveLength(2);
  expect(submitted[0]?.requestId).toBe(submitted[1]?.requestId);
  expect(remote.latest?.id).toBe('batch_1');
  const continued = await remote.continue('batch_1', 2);
  expect(continued).toMatchObject({ state: 'open', revision: 3 });
  const abandoned = await remote.abandon('batch_1', 3);
  expect(abandoned).toMatchObject({ state: 'abandoned' });
});

it('treats post-abandon and busy-room refusals as definite, not lost replies', async () => {
  for (const code of ['recovery_required', 'room_busy']) {
    const submitted: { text?: string }[] = [];
    const client = {
      broadcastList: async () => [batch],
      broadcastSubmit: async (input: unknown) => {
        submitted.push(input as { text: string });
        throw Error(code);
      },
    };
    const remote = new RemoteBroadcast(fakeConnection(client), {
      workspaceId: 'ws_ocean',
      roomId: 'room_1',
    });
    await expect(remote.submit('первый вопрос')).rejects.toThrow(code);
    // A definite refusal clears the pending binding: different text is allowed next time.
    await expect(remote.submit('другой текст')).rejects.toThrow(code);
    expect(submitted.map((input) => input.text)).toEqual(['первый вопрос', 'другой текст']);
  }
});
