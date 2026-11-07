import { taskRunId } from '@runnets/domain';
import { expect, it, vi } from 'vitest';
import { DirectChatService, createChatCommand, executeStep } from '@runnets/application';
import { roomSlices, delegate, answer } from '../test-fixtures/room-slices.js';
it('returns nested B completion to the original A delegate despite B finishing on a C result', async () => {
  const f = roomSlices(
    [
      delegate('b', 'B work'),
      delegate('c', 'C work'),
      answer('C done'),
      answer('B done'),
      answer('A done'),
    ],
    ['c'],
  );
  try {
    const start = f.start(),
      a1 = await f.execute(start.deliveries[0]!.deliveryId);
    const b1 = await f.execute(a1.roomHandoff!.deliveryId);
    const c = await f.execute(b1.roomHandoff!.deliveryId);
    const toB = f.deliveries(b1.roomDelivery!.taskId).find((d) => d.kind === 'result')!;
    expect(toB.causeId).toBe(b1.roomHandoff!.deliveryId);
    const b2 = await f.execute(toB.id);
    expect(b2.inboundMessageId).toBe('reply_' + c.id);
    const toA = f.deliveries(a1.roomDelivery!.taskId).find((d) => d.kind === 'result')!;
    expect(toA.causeId).toBe(a1.roomHandoff!.deliveryId);
    expect(toA.sourceTurnId).toBe(b2.id);
    await f.execute(toA.id);
    expect(f.turns()).toHaveLength(5);
    expect(f.requests).toHaveLength(5);
    expect(f.db!.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
it('protects a prepared room final beyond the Core summary and rejects an A1 final after yield', async () => {
  const f = roomSlices([delegate('b', 'go'), answer('x'.repeat(200) + 'original')]);
  try {
    const start = f.start(),
      a = await f.execute(start.deliveries[0]!.deliveryId);
    const b = await f.execute(a.roomHandoff!.deliveryId);
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.putChatTurn({ ...b, text: 'x'.repeat(200) + 'altered' }),
      ),
    ).toThrow();
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.putMessage({
          id: 'reply_' + a.id,
          workspaceId: a.workspaceId,
          roomId: a.roomId,
          seq: tx.nextSequence(a.roomId),
          author: 'bot',
          authorBotId: 'a',
          targetBotId: 'a',
          turnId: a.id,
          body: 'forged final',
          createdAt: f.deps.clock.now().toISOString(),
        }),
      ),
    ).toThrow();
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('retains nested prepared completion and original parent wait after assignment receipt conflict', async () => {
  const f = roomSlices(
    [delegate('b', 'B work'), delegate('c', 'C work'), answer('C final'), answer('B final')],
    ['c'],
  );
  try {
    const a = await f.execute(f.start().deliveries[0]!.deliveryId);
    const b = await f.execute(a.roomHandoff!.deliveryId);
    await f.execute(b.roomHandoff!.deliveryId);
    const result = f.deliveries(b.roomDelivery!.taskId).find((v) => v.kind === 'result')!;
    let injected = 0;
    const commands = f.store.log.commands!,
      original = commands.commitWithDisposition!.bind(commands);
    vi.spyOn(commands, 'commitWithDisposition').mockImplementation(async (...args) => {
      if (args[0].type === 'Complete') {
        injected++;
        f.db!.prepare(
          "UPDATE ocean_receipts SET binding='conflicting assignment' WHERE request_id=(SELECT request_key FROM ocean_room_deliveries WHERE id=?)",
        ).run(a.roomHandoff!.deliveryId);
      }
      return original(...args);
    });
    const completed = await f.execute(result.id);
    expect(injected).toBe(1);
    expect(
      f
        .db!.prepare(
          'SELECT binding FROM ocean_receipts WHERE request_id=(SELECT request_key FROM ocean_room_deliveries WHERE id=?)',
        )
        .get(a.roomHandoff!.deliveryId)?.['binding'],
    ).toBe('conflicting assignment');
    expect(completed.status).toBe('prepared');
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.task(a.roomDelivery!.taskId)),
    ).toMatchObject({ status: 'waiting', waitingChildId: b.roomDelivery!.taskId });
    expect(f.deliveries(a.roomDelivery!.taskId).filter((v) => v.kind === 'result')).toHaveLength(0);
    expect(
      f.db!.prepare('SELECT id FROM ocean_messages WHERE id=?').get('reply_' + completed.id),
    ).toBeUndefined();
    expect(f.deliveries(b.roomDelivery!.taskId).find((v) => v.id === result.id)?.state).toBe(
      'claimed',
    );
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
it.each(['unprepared', 'missing-final', 'wrong-final', 'absent-core'] as const)(
  'rejects marked %s completion on actual upsert',
  (mode) => {
    const f = roomSlices([]);
    try {
      const c = f.claim(f.start().deliveries[0]!.deliveryId);
      if (c.kind !== 'claimed') throw Error('claim');
      const prepared =
        mode === 'unprepared'
          ? c.turn
          : { ...c.turn, status: 'prepared' as const, preparedVersion: 7, text: 'answer' };
      if (mode !== 'unprepared') f.store.conversations.atomic((tx) => tx.putChatTurn(prepared));
      if (mode === 'wrong-final' || mode === 'absent-core')
        f.store.conversations.atomic((tx) =>
          tx.putMessage({
            id: 'reply_' + c.turn.id,
            workspaceId: c.turn.workspaceId,
            roomId: c.turn.roomId,
            seq: tx.nextSequence(c.turn.roomId),
            author: 'bot',
            authorBotId: 'a',
            targetBotId: 'a',
            turnId: c.turn.id,
            body: mode === 'wrong-final' ? 'wrong' : 'answer',
            createdAt: f.deps.clock.now().toISOString(),
          }),
        );
      expect(() =>
        f.store.conversations.atomic((tx) => tx.putChatTurn({ ...prepared, status: 'completed' })),
      ).toThrow();
      expect(f.turns()[0]?.status).toBe(prepared.status);
    } finally {
      f.close();
    }
  },
);
it.each(
  ['unprepared', 'missing-final', 'wrong-final', 'absent-core', 'running-core'].flatMap((mode) =>
    ['application', 'sqlite-run', 'sqlite-result'].map((reader) => ({ mode, reader })),
  ),
)('$reader rejects pre-existing $mode marked completion', async ({ mode, reader }) => {
  const f = roomSlices([]);
  try {
    const c = f.claim(f.start().deliveries[0]!.deliveryId);
    if (c.kind !== 'claimed') throw Error('claim');
    if (mode === 'running-core') {
      expect((await f.tasks.execute(createChatCommand(c.turn, null))).ok).toBe(true);
      for (const [type, payload] of [
        ['Admit', {}],
        ['Schedule', {}],
        [
          'StartAttempt',
          {
            attemptId: c.turn.taskRunId + '_at_0001',
            reason: 'initial',
            provider: 'fixture',
            model: 'one',
          },
        ],
      ] as const)
        expect(
          (
            await executeStep(
              f.tasks,
              taskRunId(c.turn.taskRunId),
              type,
              payload,
              (await f.tasks.state(taskRunId(c.turn.taskRunId))).version,
            )
          ).ok,
        ).toBe(true);
    }
    // Simulate corruption predating the guard update without modifying the frozen fixture.
    f.db!.exec('DROP TRIGGER ocean_room_slice_insert; DROP TRIGGER ocean_room_slice_update');
    f.db!.prepare(
      "UPDATE ocean_chat_turns SET status='completed',payload=json_set(payload,'$.status','completed','$.preparedVersion',?,'$.text','answer') WHERE id=?",
    ).run(mode === 'unprepared' ? null : 7, c.turn.id);
    if (mode === 'wrong-final' || mode === 'absent-core' || mode === 'running-core')
      f.store.conversations.atomic((tx) =>
        tx.putMessage({
          id: 'reply_' + c.turn.id,
          workspaceId: c.turn.workspaceId,
          roomId: c.turn.roomId,
          seq: tx.nextSequence(c.turn.roomId),
          author: 'bot',
          authorBotId: 'a',
          targetBotId: 'a',
          turnId: c.turn.id,
          body: mode === 'wrong-final' ? 'contradictory final' : 'answer',
          createdAt: f.deps.clock.now().toISOString(),
        }),
      );
    const query = {
      workspaceId: c.turn.workspaceId,
      roomId: c.turn.roomId,
      runId: c.turn.taskRunId,
    };
    if (reader === 'application')
      await expect(new DirectChatService(f.deps).getRun(query)).rejects.toThrow();
    if (reader === 'sqlite-run') expect(() => f.store.openRoomReads(Date.now).run(query)).toThrow();
    if (reader === 'sqlite-result')
      expect(() => f.store.openRoomReads(Date.now).result(query)).toThrow();
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('both reads reject a committed success whose head contradicts the prepared version', async () => {
  const f = roomSlices([answer('answer')]);
  try {
    const turn = await f.execute(f.start().deliveries[0]!.deliveryId);
    f.db!.exec(
      'DROP TRIGGER ocean_room_slice_insert; DROP TRIGGER ocean_room_slice_update; DROP TRIGGER ocean_room_proof_immutable',
    );
    f.db!.prepare(
      "UPDATE ocean_chat_turns SET payload=json_set(payload,'$.preparedVersion',1000) WHERE id=?",
    ).run(turn.id);
    const query = { workspaceId: turn.workspaceId, roomId: turn.roomId, runId: turn.taskRunId };
    await expect(new DirectChatService(f.deps).getRun(query)).rejects.toThrow();
    expect(() => f.store.openRoomReads(Date.now).run(query)).toThrow();
    expect(() => f.store.openRoomReads(Date.now).result(query)).toThrow();
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
