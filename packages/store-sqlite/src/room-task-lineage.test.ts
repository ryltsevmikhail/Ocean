import { expect, it } from 'vitest';
import { roomTasks, attachRoomActor, roomTaskCounts } from '../test-fixtures/room-tasks.js';
it('rejects a newly inserted parent from another root while accepting the same-root parent', () => {
  const f = roomTasks();
  try {
    const first = f.service.start(f.input),
      other = f.service.start({ ...f.input, requestId: 'other' });
    if (!first.ok || !other.ok) throw Error('start');
    const row = f.store.conversations.atomic((tx) =>
      tx.roomTasks!.task(first.value.deliveries[0]!.taskId),
    )!;
    if (row.kind !== 'bot') throw Error('task');
    const before = roomTaskCounts(f);
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.roomTasks!.putTask({
          ...row,
          id: 'bad-parent',
          parentId: other.value.deliveries[0]!.taskId,
          assigneeBotId: 'b',
        }),
      ),
    ).toThrow('invalid room task parent');
    expect(roomTaskCounts(f)).toEqual(before);
    f.store.conversations.atomic((tx) =>
      tx.roomTasks!.putTask({ ...row, id: 'valid-child', parentId: row.id, assigneeBotId: 'b' }),
    );
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.task('valid-child'))).toMatchObject({
      parentId: row.id,
      rootId: first.value.rootId,
    });
  } finally {
    f.close();
  }
});
it('rejects a fresh marked turn in a different existing room without a duplicate delivery or task hold', async () => {
  const f = roomTasks();
  try {
    const start = f.service.start(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value);
    f.store.conversations.atomic((tx) =>
      tx.putRoom({
        id: 'other-room',
        workspaceId: f.input.workspaceId,
        kind: 'group',
        title: 'Other',
        botIds: ['a', 'b', 'c'],
      }),
    );
    const source = f.store.conversations.atomic((tx) => tx.chatTurn(actor.turnId))!;
    const incoming = start.value.deliveries.find((d) => d.botId === 'b')!;
    const fresh = {
      ...source,
      id: 'fresh-turn',
      taskRunId: 'tr_fresh_turn',
      requestId: 'fresh-turn',
      roomId: 'other-room',
      bot: f.store.conversations.atomic((tx) => tx.bot('b'))!,
      roomDelivery: {
        version: 1 as const,
        taskId: incoming.taskId,
        deliveryId: incoming.deliveryId,
      },
      status: 'accepted' as const,
    };
    const before = roomTaskCounts(f);
    expect(() => f.store.conversations.atomic((tx) => tx.putChatTurn(fresh))).toThrow(
      'invalid room turn lineage',
    );
    expect(roomTaskCounts(f)).toEqual(before);
    expect(f.store.conversations.atomic((tx) => tx.chatTurn(fresh.id))).toBeNull();
    f.store.conversations.atomic((tx) => tx.putChatTurn({ ...fresh, roomId: 'room' }));
    expect(f.store.conversations.atomic((tx) => tx.chatTurn(fresh.id)?.roomDelivery)).toEqual(
      fresh.roomDelivery,
    );
  } finally {
    f.close();
  }
});
