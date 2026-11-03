import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  ConversationService,
  ChatPreparationRefusal,
  DirectChatService,
  RoomRuntimeRuns,
  TaskRunService,
} from '@runnets/application';
import { openSqliteStore } from '@runnets/store-sqlite';
import { rooms, gatedProvider } from '../../test-fixtures/local-runtime-admission.test.js';
import { RuntimeTurns } from './turns.js';

it.each(['success', 'refusal', 'unknown'] as const)(
  'settles preparation cancellation with %s evidence',
  async (outcome) => {
    const known = outcome !== 'unknown';
    const db = openSqliteStore({ path: ':memory:' });
    let release!: () => void,
      entered = false,
      dispatches = 0;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = { store: db.conversations, clock: { now: () => new Date() }, nextId: randomUUID };
    const tasks = new TaskRunService({
      log: db.log,
      clock: deps.clock,
      ids: { eventId: randomUUID, commandId: randomUUID },
    });
    const scope = rooms(new ConversationService(deps));
    const chat = new DirectChatService({
      ...deps,
      tasks,
      codingTools: {
        async forTurn() {
          entered = true;
          await gate;
          // This branch is a gated admission check that never launches preparation.
          if (outcome === 'refusal')
            throw new ChatPreparationRefusal('admission refused before launch');
          if (!known) throw Error('qualification cleanup unknown');
          return {
            definitions: [],
            execute: async () => ({ isError: false, output: '' }),
            cleanupConfirmed: true as const,
          };
        },
      },
    });
    const runs = new RoomRuntimeRuns(db.openRoomReads(Date.now), tasks);
    const owner = new RuntimeTurns(
      chat,
      gatedProvider(
        async () => {},
        () => {
          dispatches++;
        },
      ),
      runs,
      randomUUID(),
    );
    const detached = new AbortController().signal;
    try {
      const submitted = await owner.dispatch(
        'turns.submit',
        {
          workspaceId: scope.workspaceId,
          roomId: scope.roomId,
          requestId: 'one',
          text: 'first',
          taskId: 'task',
        },
        detached,
      );
      if (!('result' in submitted)) throw Error('admission failed');
      const runId = (submitted.result as { runId: string }).runId;
      const ref = { workspaceId: scope.workspaceId, roomId: scope.roomId, runId };
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(runs.reads.run(ref)).toMatchObject({
        turnStatus: 'accepted',
        taskStatus: 'created',
        version: 1,
      });
      expect(
        await owner.dispatch(
          'runs.cancel',
          { ...ref, requestId: 'cancel', expectedVersion: 1 },
          detached,
        ),
      ).toMatchObject({ result: { status: 'requested' } });
      expect(runs.reads.run(ref)).toMatchObject({
        turnStatus: 'accepted',
        taskStatus: 'cancelling',
      });
      release();
      await vi.waitFor(() =>
        expect(runs.reads.run(ref)?.turnStatus).toBe(known ? 'cancelled' : 'uncertain'),
      );
      expect(runs.reads.run(ref)?.taskStatus).toBe(known ? 'cancelled' : 'cancelling');
      expect(dispatches).toBe(0);
      expect(db.tools.inspectPending?.()).toEqual([]);
      if (known)
        expect(db.conversations.atomic((tx) => tx.activeChatTurn(scope.roomId))).toBeNull();
      // Unknown preparation is still held by aggregate state and drain, even with no tool claim.
      const next = chat.submit({
        workspaceId: scope.workspaceId,
        roomId: scope.roomId,
        requestId: 'two',
        text: 'second',
        provider: gatedProvider(
          async () => {},
          () => {},
        ),
        signal: new AbortController().signal,
        emit: () => {},
      });
      if (next.ok) await next.value.completion;
      expect(next.ok).toBe(known);
      if (!next.ok) expect(next.error.code).toBe('recovery_required');
      expect(await owner.drain()).toBe(known ? 'settled' : 'uncertain');
    } finally {
      release();
      await owner.drain();
      owner.closeObservers();
      db.close();
    }
  },
);
