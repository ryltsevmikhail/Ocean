import { expect, it } from 'vitest';
import { broadcastChildStatus, isBroadcastBatch, isBroadcastRecipient } from './broadcast.js';

const recipient = {
  botId: 'bot_1',
  handle: 'dev',
  name: 'Dev',
  provider: 'deepseek',
  model: 'deepseek-flash',
  turnId: 'turn_1',
  runId: 'tr_turn_1',
  position: 0,
};
it('derives child state from the durable turn and the batch only explains queued children', () => {
  expect(broadcastChildStatus({ state: 'open' }, 'queued')).toBe('queued');
  expect(broadcastChildStatus({ state: 'paused' }, 'queued')).toBe('queued');
  expect(broadcastChildStatus({ state: 'abandoned' }, 'queued')).toBe('not_started');
  expect(broadcastChildStatus({ state: 'open' }, 'accepted')).toBe('running');
  expect(broadcastChildStatus({ state: 'open' }, 'prepared')).toBe('running');
  expect(broadcastChildStatus({ state: 'open' }, 'completed')).toBe('answered');
  expect(broadcastChildStatus({ state: 'open' }, 'failed')).toBe('refused');
  expect(broadcastChildStatus({ state: 'open' }, 'uncertain')).toBe('uncertain');
  expect(broadcastChildStatus({ state: 'open' }, 'cancelled')).toBe('cancelled');
  expect(broadcastChildStatus({ state: 'abandoned' }, 'cancelled')).toBe('cancelled');
  expect(broadcastChildStatus({ state: 'abandoned' }, 'cancelled', true)).toBe('not_started');
  expect(broadcastChildStatus({ state: 'abandoned' }, 'queued', true)).toBe('not_started');
});
it('validates frozen recipient identity and rejects duplicate positions', () => {
  expect(isBroadcastRecipient(recipient)).toBe(true);
  expect(isBroadcastRecipient({ ...recipient, position: -1 })).toBe(false);
  expect(isBroadcastRecipient({ ...recipient, botId: '' })).toBe(false);
  const batch = {
    version: 1,
    id: 'b',
    workspaceId: 'ws',
    roomId: 'r',
    requestId: 'q',
    binding: 'binding',
    messageId: 'm',
    boundarySeq: 1,
    recipients: [recipient, { ...recipient, turnId: 'turn_2', runId: 'tr_turn_2', position: 0 }],
    state: 'open',
    revision: 1,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  };
  expect(isBroadcastBatch(batch)).toBe(false);
  expect(
    isBroadcastBatch({
      ...batch,
      recipients: [recipient, { ...recipient, turnId: 'turn_2', runId: 'tr_turn_2', position: 1 }],
    }),
  ).toBe(true);
});

it('rejects the retired refused batch state', () => {
  const base = {
    version: 1,
    id: 'b',
    workspaceId: 'ws',
    roomId: 'r',
    requestId: 'q',
    binding: 'binding',
    messageId: 'm',
    boundarySeq: 1,
    recipients: [recipient, { ...recipient, turnId: 'turn_2', runId: 'tr_turn_2', position: 1 }],
    revision: 1,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  };
  expect(isBroadcastBatch({ ...base, state: 'refused' })).toBe(false);
  for (const state of ['open', 'paused', 'completed', 'abandoned'])
    expect(isBroadcastBatch({ ...base, state })).toBe(true);
});
