import { expect, it, vi } from 'vitest';
import type { ProjectRequest } from './project-bridge.js';
import type { WorkMemory } from './project-memory.js';
import { createProjectWork } from './project-work.js';

const selection = { workspaceId: 'ws_ocean', roomId: 'dev', taskId: 'task' };
const task = {
  id: 'task',
  ownerRoomId: 'dev',
  reviewRoomId: 'review',
  status: 'reserved',
  worktreeReady: true,
};
const turn = { requestId: 'a200d890-e04f-41d4-8517-a6386ba56123', textDigest: 'b'.repeat(64) };

it('restores an unknown selected turn by receipt and refuses to send a changed body', async () => {
  const storage = { read: () => ({ turn }), write: vi.fn() };
  const request = vi.fn(async (op: string) => {
    if (op === 'task') return task;
    if (op === 'receipt') return null;
    if (op === 'history') return [];
    throw Error('unexpected_effect');
  });
  const work = createProjectWork(request as ProjectRequest, storage, 'task', 'dev');
  await work.refresh();
  expect(work.unknownTurn.value).toBe(true);
  expect(work.can.value.send).toBe(false);
  expect(request.mock.calls).toEqual([
    ['task', selection],
    ['receipt', { ...selection, requestId: turn.requestId }],
    ['history', { ...selection, after: 0 }],
  ]);
  work.text.value = 'A changed request';
  await work.send(true);
  expect(work.unknownTurn.value).toBe(true);
  expect(work.error.value).toBeTruthy();
  expect(storage.write).not.toHaveBeenCalled();
  expect(request.mock.calls).toHaveLength(3);
});

it('observes the durable receipt on a reopened task without allocating another request', async () => {
  let data: WorkMemory = { turn };
  const receipt = { requestId: turn.requestId, runId: 'original-run' };
  const snapshot = { runId: 'original-run', turnStatus: 'dispatching', version: 3 };
  const request = vi.fn(async (op: string) => {
    if (op === 'task') return task;
    if (op === 'receipt') return receipt;
    if (op === 'observe') return snapshot;
    if (op === 'history') return [];
    throw Error('unexpected_effect');
  });
  const work = createProjectWork(
    request as ProjectRequest,
    {
      read: () => data,
      write: (value) => {
        data = value;
      },
    },
    'task',
    'dev',
  );
  await work.refresh();
  expect(work.receipt.value).toEqual(receipt);
  expect(work.run.value).toEqual(snapshot);
  expect(work.active.value).toBe(true);
  expect(work.can.value.send).toBe(false);
  expect(request.mock.calls.map(([op]) => op)).toEqual(['task', 'receipt', 'observe', 'history']);
  expect(data).toEqual({ turn });
});
