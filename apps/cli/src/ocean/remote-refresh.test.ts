import { expect, it, vi } from 'vitest';
import type { LocalDecision, LocalObservedRun } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { RemoteRoomView } from './remote-room-view.js';
import { RemoteDecisions } from './remote-decisions.js';
import { RoomConnection } from './room-connection.js';

it('bounds active polling reads independently of 401 terminal runs and applied continuations', async () => {
  const scope = { workspaceId: 'ws_ocean', roomId: 'room' };
  const runs: LocalObservedRun[] = Array.from({ length: 402 }, (_, i) => ({
    ...scope,
    requestId: 'q' + i,
    turnId: String(i).padStart(4, '0'),
    runId: 'tr_run' + i,
    messageId: 'm' + i,
    performerId: 'bot',
    resultMessageId: null,
    turnStatus: i === 401 ? 'dispatching' : 'completed',
    taskStatus: i === 401 ? 'running' : 'succeeded',
    version: 0,
    pendingDecisionIds: i === 401 ? ['d0401'] : [],
  }));
  const cards: LocalDecision[] = runs.map((r, i) => ({
    ...scope,
    runId: r.runId,
    decisionId: 'd' + r.turnId,
    kind: 'continue-text-only',
    status: i === 401 ? 'pending' : 'allowed',
    version: 2,
    createdAt: 1,
    expiresAt: 9999999999999,
    previewLength: 0,
    bindingDigest: 'a'.repeat(64),
  }));
  const listRuns = vi.fn(async (q: { after?: string; limit?: number }) =>
    runs.filter((r) => r.turnId > (q.after ?? '')).slice(0, q.limit),
  );
  const listDecisions = vi.fn(async (q: { after?: string; limit?: number }) =>
    cards.filter((r) => r.decisionId > (q.after ?? '')).slice(0, q.limit),
  );
  const getRun = vi.fn(async () => runs[401]!);
  const getDecision = vi.fn(async () => cards[401]!);
  const continuationApplied = vi.fn(async () => true);
  const client = {
    history: async () => [],
    listRuns,
    getRun,
    listEvents: async () => [],
    listDecisions,
    getDecision,
    continuationApplied,
    close() {},
  } as unknown as LocalRuntimeClient;
  const view = new RemoteRoomView('room'),
    connection = new RoomConnection(client, async () => client);
  const decisions = new RemoteDecisions(connection, view);
  try {
    await view.refresh(client, true);
    await decisions.refresh();
    expect(view.entries).toHaveLength(402);
    expect(continuationApplied).toHaveBeenCalledTimes(401);
    for (const read of [listRuns, listDecisions, getRun, getDecision, continuationApplied])
      read.mockClear();
    for (let i = 0; i < 5; i++) {
      await view.refresh(client, false);
      await decisions.refresh(false);
    }
    expect(listRuns).not.toHaveBeenCalled();
    expect(listDecisions).not.toHaveBeenCalled();
    expect(continuationApplied).not.toHaveBeenCalled();
    expect(getRun).toHaveBeenCalledTimes(5);
    expect(getDecision).toHaveBeenCalledTimes(5);
    runs[401] = {
      ...runs[401]!,
      turnStatus: 'completed',
      taskStatus: 'succeeded',
      pendingDecisionIds: [],
    };
    await view.refresh(client, false);
    expect(view.active).toBe(false);
    expect(view.entries).toHaveLength(402);
    await view.refresh(client, true);
    await decisions.refresh(true);
    expect(listRuns).toHaveBeenCalled();
    expect(listDecisions).toHaveBeenCalled();
    expect(continuationApplied).not.toHaveBeenCalled();
  } finally {
    connection.close();
  }
});
