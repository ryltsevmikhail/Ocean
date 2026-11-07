import type { ChatTurn } from '@runnets/domain';
import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeRoomTasks } from './room-tasks.js';
import { roomSlices, answer } from '../../../../packages/store-sqlite/test-fixtures/room-slices.js';
it('starts both persisted recoverable claims with one trusted slot without stranding the overflow', async () => {
  const f = roomSlices([answer('first'), answer('second')]);
  const start = f.service.startHosted(f.input);
  if (!start.ok) throw Error('start');
  const claims = start.value.deliveries.map((d) => f.claim(d.deliveryId));
  expect(claims.every((c) => c.kind === 'claimed')).toBe(true);
  const original = f.turns().map((t) => [t.id, t.taskRunId, t.activation]);
  const supervisor = new RuntimeRoomTasks(
    f.service,
    f.deps,
    f.deps,
    f.store.openRoomReads(Date.now),
    'restart',
    1,
  );
  try {
    supervisor.start();
    const deadline = Date.now() + 2000;
    while (f.turns().some((t) => t.status !== 'completed') && Date.now() < deadline) await delay(5);
    expect(f.turns().map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(f.turns().map((t) => [t.id, t.taskRunId, t.activation])).toEqual(original);
    expect(f.requests).toHaveLength(2);
    supervisor.start();
    await delay(20);
    expect(f.requests).toHaveLength(2);
  } finally {
    await supervisor.drain();
    f.close();
  }
});
it('holds a persistent pre-dispatch refusal without starving a second root or owner queries', async () => {
  const { ChatPreparationRefusal } = await import('@runnets/application');
  const f = roomSlices([answer('other root')]);
  const first = f.start();
  let attempts = 0;
  const execution = {
    ...f.deps,
    grantedTools: {
      async forTurn(turn: ChatTurn) {
        const root = f.store.conversations.atomic(
          (tx) => tx.roomTasks!.task(turn.roomDelivery!.taskId)!.rootId,
        );
        if (root === first.rootId) {
          attempts++;
          // Bound the broken implementation's microtask loop so its RED terminates.
          if (attempts === 10)
            f.db!.prepare(
              "UPDATE ocean_room_tasks SET status='paused',revision=revision+1 WHERE id=?",
            ).run(first.rootId);
          throw new ChatPreparationRefusal('worktree lease lost');
        }
        return null;
      },
    },
  };
  const other = f.service.startHosted({ ...f.input, requestId: 'other', initialBotIds: ['a'] });
  if (!other.ok) throw Error('other');
  const supervisor = new RuntimeRoomTasks(
    f.service,
    f.deps,
    execution,
    f.store.openRoomReads(Date.now),
    'held',
    1,
  );
  try {
    supervisor.start();
    for (let i = 0; f.requests.length < 1 && i < 200; i++) await delay(5);
    expect(f.requests).toHaveLength(1);
    expect(attempts).toBe(1);
    expect(
      supervisor.dispatch(
        'roomTasks.get',
        { workspaceId: f.input.workspaceId, roomId: 'room', rootId: first.rootId },
        new AbortController().signal,
        { roomTasks: true, addressedHistory: true, models: true },
      ),
    ).toMatchObject({ result: { status: 'ready' } });
    supervisor.wake();
    await delay(10);
    expect(attempts).toBe(1);
  } finally {
    await supervisor.drain();
    f.close();
  }
});

it('retires a proved stopped held job before clean host drainage, without any model stream', async () => {
  const { ChatPreparationRefusal } = await import('@runnets/application');
  const { assertRuntimeDrained } = await import('./drain-supervision.js');
  const f = roomSlices([]),
    start = f.start();
  let attempts = 0;
  const supervisor = new RuntimeRoomTasks(
    f.service,
    f.deps,
    {
      ...f.deps,
      grantedTools: {
        async forTurn() {
          attempts++;
          throw new ChatPreparationRefusal('pre-dispatch hold');
        },
      },
    },
    f.store.openRoomReads(Date.now),
    'stop-held',
    1,
  );
  try {
    supervisor.start();
    for (let i = 0; attempts < 1 && i < 100; i++) await delay(5);
    expect(attempts).toBe(1);
    const turn = f.turns()[0]!;
    const stop = {
      workspaceId: f.input.workspaceId,
      roomId: 'room',
      rootId: start.rootId,
      requestId: 'stop',
      expectedRevision: 1,
    };
    expect(
      await supervisor.dispatch('roomTasks.stop', stop, new AbortController().signal, {
        roomTasks: true,
        addressedHistory: true,
        models: true,
      }),
    ).toMatchObject({ result: { status: 'stopped' } });
    expect(f.turns()[0]?.status).toBe('cancelled');
    expect(f.requests).toHaveLength(0);
    await expect(assertRuntimeDrained([supervisor], 1000)).resolves.toBeUndefined();
    expect(supervisor.controllerFor(turn.taskRunId)).toBeUndefined();
  } finally {
    await supervisor.drain();
    f.close();
  }
});
it.each(['own', 'unscoped'] as const)(
  'keeps %s unknown effect evidence uncertain rather than releasing or retrying it',
  async (scope) => {
    const { ChatPreparationRefusal } = await import('@runnets/application');
    const { assertRuntimeDrained } = await import('./drain-supervision.js');
    const f = roomSlices([]),
      start = f.start();
    let attempts = 0;
    const supervisor = new RuntimeRoomTasks(
      f.service,
      f.deps,
      {
        ...f.deps,
        grantedTools: {
          async forTurn(turn: ChatTurn) {
            attempts++;
            if (scope === 'unscoped')
              f.db!.exec("INSERT INTO tool_invocations_v1 VALUES('unknown','legacy','uncertain')");
            else
              f.db!.prepare('INSERT INTO tool_invocations_v2 VALUES(?,?,?,?,?,?,NULL)').run(
                'unknown',
                'legacy',
                turn.taskRunId,
                'unknown',
                'unknown',
                'uncertain',
              );
            throw new ChatPreparationRefusal('unknown effect remains');
          },
        },
      },
      f.store.openRoomReads(Date.now),
      'unknown',
      1,
    );
    try {
      supervisor.start();
      for (let i = 0; attempts < 1 && i < 100; i++) await delay(5);
      await delay(10);
      expect(attempts).toBe(1);
      expect(f.requests).toHaveLength(0);
      const journal = f.store.tools.inspectPending!();
      expect(journal).toHaveLength(1);
      expect(
        await supervisor.dispatch(
          'roomTasks.stop',
          {
            workspaceId: f.input.workspaceId,
            roomId: 'room',
            rootId: start.rootId,
            requestId: 'stop',
            expectedRevision: 1,
          },
          new AbortController().signal,
          { roomTasks: true, addressedHistory: true, models: true },
        ),
      ).toMatchObject({ result: { status: 'stopped' } });
      expect(f.turns()[0]?.status).toBe('accepted');
      expect(f.store.tools.inspectPending!()).toEqual(journal);
      await expect(assertRuntimeDrained([supervisor], 1000)).rejects.toThrow('stop_incomplete');
    } finally {
      await supervisor.drain();
      f.close();
    }
  },
);
