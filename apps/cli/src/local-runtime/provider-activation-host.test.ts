import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  ConversationService,
  DirectChatService,
  RoomRuntimeRuns,
  TaskRunService,
  injectedProviderActivation,
} from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
import { rooms, gatedProvider } from '../../test-fixtures/local-runtime-admission.test.js';
import { RuntimeTurns } from './turns.js';

it('passes the resolver untouched so host note, conflict and draining replay bypass activation', async () => {
  const db = openSqliteStore({ path: ':memory:' });
  const clock = { now: () => new Date() };
  const deps = { store: db.conversations, clock, nextId: randomUUID };
  const tasks = new TaskRunService({
    log: db.log,
    clock,
    ids: { eventId: randomUUID, commandId: randomUUID },
  });
  const scope = rooms(new ConversationService(deps));
  const { groupId, ...request } = scope;
  const reads = new RoomRuntimeRuns(db.openRoomReads(Date.now), tasks);
  const resolve = vi.fn(
    injectedProviderActivation(
      gatedProvider(
        async () => {},
        () => {},
      ),
    ).resolve,
  );
  const runner = new RuntimeTurns(
    new DirectChatService({ ...deps, tasks }),
    { resolve },
    reads,
    randomUUID(),
  );
  const detached = new AbortController().signal;
  try {
    const first = await runner.dispatch('turns.submit', request, detached);
    expect(first).toHaveProperty('result');
    if (!('result' in first)) throw Error('admission');
    const runId = (first.result as { runId: string }).runId;
    await vi.waitFor(() =>
      expect(reads.reads.run({ ...scope, runId })?.turnStatus).toBe('completed'),
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    resolve.mockClear();
    resolve.mockImplementation(() => {
      throw Error('must bypass resolver');
    });
    expect(
      await runner.dispatch(
        'turns.submit',
        { ...request, roomId: groupId, requestId: 'note' },
        detached,
      ),
    ).toHaveProperty('result');
    expect(await runner.drain()).toBe('settled');
    expect(await runner.dispatch('turns.submit', request, detached)).toEqual(first);
    expect(
      await runner.dispatch('turns.submit', { ...request, text: 'conflict' }, detached),
    ).toMatchObject({ error: { code: 'request_conflict' } });
    expect(
      await runner.dispatch('turns.submit', { ...request, requestId: 'fresh' }, detached),
    ).toMatchObject({ error: { code: 'runtime_draining' } });
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    await runner.drain();
    runner.closeObservers();
    db.close();
  }
});
