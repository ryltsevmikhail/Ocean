import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BroadcastBatch } from '../protocol.js';
import {
  abandonBroadcast,
  broadcastBatch,
  broadcastBlocksSending,
  broadcastBusy,
  broadcastError,
  broadcastIsPaused,
  broadcastMessage,
  continueBroadcast,
  pendingBroadcast,
  readBroadcast,
  resetBroadcastState,
  sendOwnedBroadcast,
} from './broadcast-state.js';

const batch: BroadcastBatch = {
  // request ids on the wire are UUIDs
  version: 1,
  id: 'batch_1',
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  requestId: crypto.randomUUID(),
  messageId: 'message_1',
  boundarySeq: 2,
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
      state: 'queued',
      resultMessageId: null,
    },
  ],
  state: 'paused',
  revision: 2,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:01.000Z',
};
type Reply =
  { version: 1; ok: true; data: unknown } | { version: 1; ok: false; error: { code: string } };
const ok = (data: unknown): Reply => ({ version: 1, ok: true, data });
const fail = (code: string): Reply => ({ version: 1, ok: false, error: { code } });
function channel(replies: Reply[]) {
  const request = vi.fn<(message: unknown) => Promise<unknown>>();
  for (const reply of replies) request.mockResolvedValueOnce(reply);
  vi.stubGlobal('window', { ocean: { request } });
  return request;
}
beforeEach(() => resetBroadcastState());
afterEach(() => {
  vi.unstubAllGlobals();
  resetBroadcastState();
});
it('reads the room batch and exposes paused/blocking state', async () => {
  const request = channel([ok([batch])]);
  await readBroadcast('room_1');
  expect(request).toHaveBeenCalledWith({ op: 'broadcast-list', room: 'room_1' });
  expect(broadcastBatch.value).toEqual(batch);
  expect(broadcastIsPaused.value).toBe(true);
  expect(broadcastBlocksSending.value).toBe(true);
});
it('submits once, reports refusals, and retries a lost reply with the same request id', async () => {
  const request = channel([ok(batch)]);
  const outcome = await sendOwnedBroadcast({ room: 'room_1', text: 'всем', attachments: [] });
  expect(outcome.kind).toBe('submitted');
  expect(broadcastBatch.value).toEqual(batch);
  expect(pendingBroadcast('room_1')).toBeUndefined();
  const sent = request.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(sent).toMatchObject({ op: 'broadcast', room: 'room_1', text: 'всем' });
  expect(typeof sent['requestId']).toBe('string');

  channel([fail('batch_open')]);
  expect((await sendOwnedBroadcast({ room: 'room_1', text: 'снова', attachments: [] })).kind).toBe(
    'refused',
  );
  expect(pendingBroadcast('room_1')).toBeUndefined();

  channel([{ version: 1, ok: false, error: { code: 'runtime_unreachable' } }]);
  const lost = await sendOwnedBroadcast({ room: 'room_1', text: 'потеряно', attachments: [] });
  expect(lost.kind).toBe('unconfirmed');
  const pending = pendingBroadcast('room_1');
  expect(pending).toMatchObject({ text: 'потеряно' });
  expect(lost.kind === 'unconfirmed' && pending?.requestId === lost.requestId).toBe(true);
});
it('continues and abandons the displayed batch with its revision', async () => {
  const request = channel([ok([batch]), ok({ ...batch, state: 'open', revision: 3 })]);
  await readBroadcast('room_1');
  await continueBroadcast();
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
    op: 'broadcast-continue',
    room: 'room_1',
    batchId: 'batch_1',
    expectedRevision: 2,
  });
  expect(broadcastBatch.value?.state).toBe('open');
  expect(broadcastMessage.value).toContain('продолжена');
  channel([fail('batch_uncertain')]);
  await abandonBroadcast();
  expect(broadcastError.value).toBe(true);
  expect(broadcastBusy.value).toBe(false);
});
