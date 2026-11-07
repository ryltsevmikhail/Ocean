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

it('restores the prior receipt and accepts an edited dev message after a context-limit refusal', async () => {
  let data: WorkMemory = { turn };
  let accepted = turn.requestId;
  const receipt = () => ({ requestId: accepted, runId: 'run-' + accepted });
  const request = vi.fn(async (op: string, input: { requestId: string; text?: string }) => {
    if (op === 'task') return task;
    if (op === 'history') return [];
    if (op === 'receipt') return receipt();
    if (op === 'observe') return { ...receipt(), turnStatus: 'completed', version: 4 };
    if (op === 'send' && input.text !== 'Shorter message') throw Error('context_limit');
    if (op === 'send') {
      accepted = input.requestId;
      return receipt();
    }
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
  work.text.value = 'Over the remaining context budget';
  await work.send();
  expect(work.text.value).toBe('Over the remaining context budget');
  expect(data.turn).toEqual(turn);
  expect(work.receipt.value?.requestId).toBe(turn.requestId);
  expect(work.unknownTurn.value).toBe(false);
  expect(work.can.value.send).toBe(true);
  expect(work.can.value.capture).toBe(true);
  expect(work.error.value).toContain('Сократите текст');
  work.text.value = 'Shorter message';
  await work.send();
  expect(accepted).not.toBe(turn.requestId);
  expect(work.receipt.value?.requestId).toBe(accepted);
  expect(work.text.value).toBe('');
});

it.each([
  { firstVersion: 3, refusal: 'version_conflict' },
  { firstVersion: 0, refusal: 'run_not_started' },
  { firstVersion: 3, refusal: 'client_busy' },
])(
  'allows explicit cancel after $refusal but preserves an unknown attempt',
  async ({ firstVersion, refusal }) => {
    let data: WorkMemory = { turn };
    let version = firstVersion;
    const receipt = { requestId: turn.requestId, runId: 'original-run' };
    const request = vi.fn(async (op: string, _input: unknown) => {
      if (op === 'task') return task;
      if (op === 'receipt') return receipt;
      if (op === 'observe') return { runId: 'original-run', turnStatus: 'dispatching', version };
      if (op === 'history') return [];
      if (op === 'cancel' && version === firstVersion) {
        version = 4;
        throw Error(refusal);
      }
      if (op === 'cancel') throw Error('outcome_unknown');
      throw Error('unexpected_effect');
    });
    const storage = {
      read: () => data,
      write: (value: WorkMemory) => {
        data = value;
      },
    };
    const work = createProjectWork(request as ProjectRequest, storage, 'task', 'dev');
    await work.refresh();
    await work.cancel();
    expect(work.run.value?.version).toBe(4);
    expect(data.turn?.cancelId).toBeUndefined();
    await work.cancel();
    expect(work.cancelRequested.value).toBe(true);
    const retainedId = data.turn?.cancelId;
    expect(retainedId).toBeTruthy();
    work.close();
    const reattached = createProjectWork(request as ProjectRequest, storage, 'task', 'dev');
    await reattached.refresh();
    expect(reattached.cancelRequested.value).toBe(true);
    await reattached.cancel();
    const cancels = request.mock.calls.filter(([op]) => op === 'cancel').map(([, input]) => input);
    expect(cancels).toEqual([
      {
        ...selection,
        requestId: turn.requestId,
        cancelId: expect.any(String),
        expectedVersion: firstVersion,
      },
      { ...selection, requestId: turn.requestId, cancelId: retainedId, expectedVersion: 4 },
    ]);
    expect(data.turn?.cancelId).toBe(retainedId);
  },
);
