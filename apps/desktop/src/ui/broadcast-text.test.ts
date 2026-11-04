import { expect, it } from 'vitest';
import { BROADCAST_RECIPIENT, isBroadcastRecipient } from './broadcast-mode.js';
import {
  broadcastBlocksNewTurns,
  broadcastChildLine,
  broadcastChildText,
  broadcastPaused,
  broadcastStateText,
  broadcastSummary,
  sendBlockedHint,
} from './broadcast-text.js';
import type { BroadcastBatch } from '../protocol.js';

const batch: BroadcastBatch = {
  version: 1,
  id: 'batch_1',
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  requestId: crypto.randomUUID(),
  messageId: 'message_1',
  boundarySeq: 4,
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
  revision: 3,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:01.000Z',
};
it('separates the explicit broadcast action from the note path', () => {
  expect(BROADCAST_RECIPIENT).toBe('*');
  expect(isBroadcastRecipient('*')).toBe(true);
  expect(isBroadcastRecipient('')).toBe(false);
  expect(isBroadcastRecipient('dev')).toBe(false);
});
it('summarizes every batch and child state without transport metadata', () => {
  expect(broadcastSummary(batch)).toBe('Рассылка приостановлена · 1 из 2 ответили · ревизия 3');
  for (const state of Object.keys(broadcastChildText)) void state;
  expect(broadcastChildLine(batch.recipients[0]!)).toContain('@dev — Ответил');
  expect(broadcastChildLine(batch.recipients[1]!)).toContain('@review — Ожидает очереди');
  expect(Object.keys(broadcastStateText)).toEqual(['open', 'paused', 'completed', 'abandoned']);
  expect(sendBlockedHint(batch, 'dev')).toContain('рассылки');
  expect(sendBlockedHint(batch, '')).toBe('');
  expect(sendBlockedHint(null, 'dev')).toBe('');
  expect(broadcastPaused(batch)).toBe(true);
  expect(broadcastBlocksNewTurns(batch)).toBe(true);
  expect(broadcastBlocksNewTurns({ ...batch, state: 'completed' })).toBe(false);
  expect(broadcastBlocksNewTurns(null)).toBe(false);
});
