import { expect, it } from 'vitest';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { LocalBroadcastBatch } from '@runnets/contracts';
import { waitForBroadcastSettlement } from './broadcast-command.js';

const openBatch = {
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
      state: 'running',
      resultMessageId: null,
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
      state: 'queued',
      resultMessageId: null,
    },
  ],
  state: 'open',
  revision: 1,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
} as unknown as LocalBroadcastBatch;
function fakeClient(batch: LocalBroadcastBatch, calls: unknown[] = []): LocalRuntimeClient {
  return {
    broadcastGet: async (query: unknown) => {
      calls.push(query);
      return batch;
    },
  } as unknown as LocalRuntimeClient;
}
it('reports a durable bound instead of waiting forever for an open batch', async () => {
  const calls: unknown[] = [];
  const started = Date.now();
  await expect(
    waitForBroadcastSettlement(
      fakeClient(openBatch, calls),
      { workspaceId: 'ws_ocean', roomId: 'room_1' },
      openBatch,
      { write: () => true } as never,
      true,
      new AbortController().signal,
      80,
    ),
  ).rejects.toThrow('broadcast_pending');
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(calls.length).toBeGreaterThan(0);
});
