import { taskRunId } from '@runnets/domain';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  recoverChats,
  claimRoomDelivery,
  recoverUnstartedRoomClaims,
  executeChatTurn,
  repairRoomHandoff,
  createChatCommand,
  executeStep,
  TaskRunService,
  type ConversationStore,
} from '@runnets/application';
import { roomSlices, delegate, answer } from '../test-fixtures/room-slices.js';
import { openSqliteStore } from './index.js';

it('two connections claim once and only the accepted→dispatching winner enters the engine', async () => {
  const f = roomSlices([answer('once')]);
  const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
  const other = openSqliteStore({ path });
  try {
    const start = f.start(),
      id = start.deliveries[0]!.deliveryId;
    const c1 = f.claim(id),
      c2 = claimRoomDelivery({ ...f.deps, store: other.conversations }, id);
    expect(c1.kind).toBe('claimed');
    expect(c2.kind).toBe('existing');
    if (c1.kind !== 'claimed') throw Error('claim');
    const tasks = new TaskRunService({
      log: other.log,
      clock: f.deps.clock,
      ids: { commandId: () => 'unused', eventId: () => 'unused' },
    });
    const input = { ...c1, signal: new AbortController().signal, emit() {} };
    const results = await Promise.allSettled([
      executeChatTurn(f.deps, input, c1),
      executeChatTurn({ ...f.deps, store: other.conversations, tasks }, input, c1),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
    expect(
      f
        .db!.prepare("SELECT count(*) AS n FROM events WHERE type='attempt.model_request_started'")
        .get()?.['n'],
    ).toBe(1);
  } finally {
    other.close();
    f.close();
  }
});
it.each(['absent', 'created', 'started', 'model-started'] as const)(
  'discovers only proven unstarted %s claims after a fresh connection',
  async (phase) => {
    const directory = mkdtempSync(join(tmpdir(), 'room-reopen-'));
    const f = roomSlices([answer('recovered')], ['b'], join(directory, 'store.sqlite'));
    let closed = false;
    let reopened: ReturnType<typeof openSqliteStore> | undefined;
    try {
      const start = f.start(),
        claimed = f.claim(start.deliveries[0]!.deliveryId);
      if (claimed.kind !== 'claimed') throw Error('claim');
      if (phase !== 'absent')
        expect((await f.tasks.execute(createChatCommand(claimed.turn, null))).ok).toBe(true);
      if (phase === 'started' || phase === 'model-started')
        for (const [type, payload] of [
          ['Admit', {}],
          ['Schedule', {}],
          [
            'StartAttempt',
            {
              attemptId: claimed.turn.taskRunId + '_at_0001',
              reason: 'initial',
              provider: 'fixture',
              model: 'one',
            },
          ],
        ] as const) {
          const state = await f.tasks.state(taskRunId(claimed.turn.taskRunId));
          expect(
            (
              await executeStep(
                f.tasks,
                taskRunId(claimed.turn.taskRunId),
                type,
                payload,
                state.version,
              )
            ).ok,
          ).toBe(true);
        }
      if (phase === 'model-started') {
        const state = await f.tasks.state(taskRunId(claimed.turn.taskRunId));
        expect(
          (
            await executeStep(
              f.tasks,
              taskRunId(claimed.turn.taskRunId),
              'StartModelRequest',
              {
                attemptId: claimed.turn.taskRunId + '_at_0001',
                ordinal: 1,
                activation: claimed.turn.activation!,
                startedAt: f.deps.clock.now().toISOString(),
              },
              state.version,
            )
          ).ok,
        ).toBe(true);
      }
      const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
      f.close();
      closed = true;
      reopened = openSqliteStore({ path });
      const tasks = new TaskRunService({
        log: reopened.log,
        clock: f.deps.clock,
        ids: { commandId: () => 'unused', eventId: () => 'unused' },
      });
      const deps = { ...f.deps, store: reopened.conversations, tasks };
      await recoverChats(deps.store, tasks, deps.clock);
      const eligible = recoverUnstartedRoomClaims(deps);
      expect(eligible).toHaveLength(phase === 'started' || phase === 'model-started' ? 0 : 1);
      expect(f.requests).toHaveLength(0);
      if (eligible[0]) {
        const c = eligible[0];
        const result = await executeChatTurn(
          deps,
          { ...c, signal: new AbortController().signal, emit() {} },
          c,
        );
        expect(result.id).toBe(claimed.turn.id);
        expect(result.text).toBe('recovered');
        expect(
          (await tasks.events(taskRunId(claimed.turn.taskRunId))).filter(
            (e) => e.type === 'task_run.created',
          ),
        ).toHaveLength(1);
      }
    } finally {
      reopened?.close();
      if (!closed) f.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it('repairs a committed delegate transaction without provider reentry and yields once', async () => {
  const f = roomSlices([delegate('b', 'go')]);
  try {
    const start = f.start(),
      execute = f.tasks.executeWithDisposition.bind(f.tasks);
    f.tasks.executeWithDisposition = async (command) => {
      if (command.type === 'Complete') throw Error('crash before local Complete');
      return execute(command);
    };
    const saved = await f.execute(start.deliveries[0]!.deliveryId);
    expect(saved.roomHandoff).toBeDefined();
    expect(saved.roomSliceDisposition).toBeUndefined();
    expect(f.claim(saved.roomHandoff!.deliveryId).kind).toBe('held');
    f.tasks.executeWithDisposition = execute;
    expect(await repairRoomHandoff(f.deps, saved.id)).toMatchObject({
      roomSliceDisposition: 'yielded',
    });
    const before = f.db!.prepare('SELECT * FROM events').all();
    expect(await repairRoomHandoff(f.deps, saved.id)).toMatchObject({
      roomSliceDisposition: 'yielded',
    });
    expect(f.db!.prepare('SELECT * FROM events').all()).toEqual(before);
    expect(f.requests).toHaveLength(1);
    expect(f.claim(saved.roomHandoff!.deliveryId).kind).toBe('claimed');
  } finally {
    f.close();
  }
});
it.each(['yield', 'final', 'result', 'response'] as const)(
  'repairs crash at %s transaction boundary with no duplicate effects',
  async (phase) => {
    const directory = mkdtempSync(join(tmpdir(), 'room-repair-')),
      path = join(directory, 'store.sqlite');
    const f = roomSlices([delegate('b', 'go'), answer('B final')], ['b'], path);
    let closed = false;
    let reopened: ReturnType<typeof openSqliteStore> | undefined;
    try {
      const start = f.start();
      let fail = phase === 'yield';
      const base = f.deps.store;
      const store: ConversationStore = {
        atomic(work) {
          const value = base.atomic((tx) =>
            work({
              ...tx,
              putChatTurn(turn) {
                if (fail && phase === 'yield' && turn.roomSliceDisposition === 'yielded')
                  throw Error('crash before yield');
                tx.putChatTurn(turn);
              },
              putMessage(message) {
                if (fail && phase === 'final' && message.id.startsWith('reply_'))
                  throw Error('crash before final');
                tx.putMessage(message);
              },
              putReceipt(key, receipt) {
                if (fail && phase === 'result' && key.startsWith('room-result/'))
                  throw Error('crash inside result');
                tx.putReceipt(key, receipt);
              },
            }),
          );
          if (
            fail &&
            phase === 'response' &&
            f.db!.prepare("SELECT 1 FROM ocean_room_deliveries WHERE kind='result'").get()
          )
            throw Error('lost committed response');
          return value;
        },
      };
      const run = async (id: string) => {
        const c = claimRoomDelivery({ ...f.deps, store }, id);
        if (c.kind !== 'claimed') throw Error('claim');
        return executeChatTurn(
          { ...f.deps, store },
          { ...c, signal: new AbortController().signal, emit() {} },
          c,
        );
      };
      if (phase === 'yield') {
        await expect(run(start.deliveries[0]!.deliveryId)).rejects.toThrow('crash before yield');
        fail = false;
        const saved = f.turns()[0]!;
        f.close();
        closed = true;
        reopened = openSqliteStore({ path });
        const tasks = new TaskRunService({
          log: reopened.log,
          clock: f.deps.clock,
          ids: { commandId: () => 'unused', eventId: () => 'unused' },
        });
        const deps = { ...f.deps, tasks, store: reopened.conversations };
        expect(await repairRoomHandoff(deps, saved.id)).toMatchObject({
          roomSliceDisposition: 'yielded',
        });
        expect(await repairRoomHandoff(deps, saved.id)).toMatchObject({
          roomSliceDisposition: 'yielded',
        });
        expect(claimRoomDelivery(deps, saved.roomHandoff!.deliveryId).kind).toBe('claimed');
        expect(f.requests).toHaveLength(1);
        return;
      } else await run(start.deliveries[0]!.deliveryId);
      const a = f.turns()[0]!,
        childId = a.roomHandoff!.deliveryId;
      fail = true;
      await expect(run(childId)).rejects.toThrow();
      if (phase !== 'response')
        expect(
          f.db!.prepare("SELECT 1 FROM ocean_room_deliveries WHERE kind='result'").get(),
        ).toBeUndefined();
      fail = false;
      const b = f.turns()[1]!;
      expect(await repairRoomHandoff(f.deps, b.id)).toMatchObject({ status: 'completed' });
      expect(await repairRoomHandoff(f.deps, b.id)).toMatchObject({ status: 'completed' });
      expect(
        f
          .db!.prepare("SELECT count(*) AS n FROM ocean_room_deliveries WHERE kind='result'")
          .get()?.['n'],
      ).toBe(1);
      expect(
        f.db!.prepare("SELECT count(*) AS n FROM ocean_messages WHERE id LIKE 'reply_%'").get()?.[
          'n'
        ],
      ).toBe(1);
      expect(f.db!.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(f.requests).toHaveLength(2);
    } finally {
      reopened?.close();
      if (!closed) f.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
