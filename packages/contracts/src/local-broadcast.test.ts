import { describe, expect, it } from 'vitest';
import {
  BROADCAST_MAX_ATTACHMENTS,
  LOCAL_BROADCAST_METHODS,
  LOCAL_BROADCAST_READ_METHODS,
  isLocalBroadcastBatch,
  isLocalBroadcastGet,
  isLocalBroadcastList,
  isLocalBroadcastSubmit,
  isLocalBroadcastVote,
  type LocalBroadcastBatch,
} from './index.js';

const batch: LocalBroadcastBatch = {
  version: 1,
  id: 'batch_1',
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  requestId: 'request_1',
  messageId: 'message_1',
  boundarySeq: 3,
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
      model: 'deepseek-v4-pro',
      turnId: 'turn_2',
      runId: 'tr_turn_2',
      position: 1,
      state: 'queued',
      resultMessageId: null,
    },
  ],
  state: 'open',
  revision: 2,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:01.000Z',
};
describe('broadcast contract', () => {
  it('declares the runtime-owned broadcast methods', () => {
    expect(LOCAL_BROADCAST_METHODS).toEqual([
      'broadcasts.submit',
      'broadcasts.get',
      'broadcasts.list',
      'broadcasts.continue',
      'broadcasts.abandon',
    ]);
  });
  it('validates a metadata-only batch DTO', () => {
    expect(isLocalBroadcastBatch(batch)).toBe(true);
    expect(isLocalBroadcastBatch({ ...batch, key: 'sk-leak' })).toBe(false);
    expect(
      isLocalBroadcastBatch({
        ...batch,
        state: 'paused',
        recipients: batch.recipients.slice(0, 1),
      }),
    ).toBe(false);
    expect(
      isLocalBroadcastBatch({
        ...batch,
        recipients: [{ ...batch.recipients[0]!, state: 'unknown' }, batch.recipients[1]!],
      }),
    ).toBe(false);
    expect(isLocalBroadcastBatch({ ...batch, revision: 0 })).toBe(false);
    expect(isLocalBroadcastBatch({ ...batch, boundarySeq: 0 })).toBe(false);
    expect(JSON.stringify(batch)).not.toContain('sk-');
  });
  it('validates submit/get/list/vote params', () => {
    expect(
      isLocalBroadcastSubmit({
        workspaceId: 'ws_ocean',
        roomId: 'room_1',
        requestId: 'request_1',
        text: 'всем вопрос',
        attachments: ['att_1'],
      }),
    ).toBe(true);
    expect(
      isLocalBroadcastSubmit({ workspaceId: 'other', roomId: 'r', requestId: 'q', text: 't' }),
    ).toBe(false);
    expect(
      isLocalBroadcastSubmit({ workspaceId: 'ws_ocean', roomId: 'r', requestId: 'q', text: '' }),
    ).toBe(false);
    expect(
      isLocalBroadcastSubmit({
        workspaceId: 'ws_ocean',
        roomId: 'r',
        requestId: 'q',
        text: 't',
        attachments: Array.from({ length: BROADCAST_MAX_ATTACHMENTS + 1 }, (_, i) => 'a' + i),
      }),
    ).toBe(false);
    expect(isLocalBroadcastGet({ workspaceId: 'ws_ocean', roomId: 'r', batchId: 'b' })).toBe(true);
    expect(isLocalBroadcastGet({ workspaceId: 'ws_ocean', roomId: 'r', requestId: 'q' })).toBe(
      true,
    );
    expect(isLocalBroadcastGet({ workspaceId: 'ws_ocean', roomId: 'r' })).toBe(false);
    expect(
      isLocalBroadcastGet({ workspaceId: 'ws_ocean', roomId: 'r', batchId: 'b', requestId: 'q' }),
    ).toBe(false);
    expect(isLocalBroadcastList({ workspaceId: 'ws_ocean', roomId: 'r' })).toBe(true);
    expect(
      isLocalBroadcastVote({
        workspaceId: 'ws_ocean',
        roomId: 'r',
        batchId: 'b',
        expectedRevision: 2,
      }),
    ).toBe(true);
    expect(
      isLocalBroadcastVote({
        workspaceId: 'ws_ocean',
        roomId: 'r',
        batchId: 'b',
        expectedRevision: -1,
      }),
    ).toBe(false);
  });
});

it('retires the refused batch state and exposes the restore-safe read methods', () => {
  expect(LOCAL_BROADCAST_READ_METHODS).toEqual(['broadcasts.get', 'broadcasts.list']);
  expect(isLocalBroadcastBatch({ ...batch, state: 'refused' })).toBe(false);
  for (const state of ['open', 'paused', 'completed', 'abandoned'])
    expect(isLocalBroadcastBatch({ ...batch, state })).toBe(true);
});
