import { expect, it } from 'vitest';
import { hostedRoomTasks, roomTaskCounts } from '../test-fixtures/room-tasks.js';
import { RoomTaskPersistence } from '@runnets/application';
it('lists 51 roots once despite initial siblings with exact descending exclusive pages and no writes', () => {
  const f = hostedRoomTasks();
  try {
    expect(
      f.store.conversations.atomic((tx) =>
        tx.roomTasks!.list({ workspaceId: f.input.workspaceId, roomId: 'room' }, 'owner'),
      ),
    ).toEqual({ workspaceId: f.input.workspaceId, roomId: 'room', roots: [], nextBeforeSeq: null });
    const receipts = Array.from({ length: 51 }, (_, i) => {
      const result = f.service.startHosted({ ...f.input, requestId: `start-${i}` });
      if (!result.ok) throw Error(result.error.code);
      return result.value;
    });
    for (const [i, status] of ['completed', 'paused', 'stopped', 'waiting'].entries())
      f.db!.prepare('UPDATE ocean_room_tasks SET status=?,revision=2 WHERE id=?').run(
        status,
        receipts[i]!.rootId,
      );
    const other = new RoomTaskPersistence({ ...f.service.deps, ownerId: 'foreign' });
    expect(other.start({ ...f.input, requestId: 'foreign-owner' }).ok).toBe(true);
    expect(f.service.start({ ...f.input, requestId: 'unbound' }).ok).toBe(true);
    f.store.conversations.atomic((tx) =>
      tx.putRoom({
        id: 'other-room',
        workspaceId: f.input.workspaceId,
        kind: 'direct',
        botId: 'a',
      }),
    );
    expect(
      f.service.startHosted({
        ...f.input,
        roomId: 'other-room',
        requestId: 'other-room',
        initialBotIds: ['a'],
        participants: [f.input.participants[0]!],
      }).ok,
    ).toBe(true);
    const before = roomTaskCounts(f);
    const read = (beforeSeq?: number, limit?: number) =>
      f.store.conversations.atomic((tx) =>
        tx.roomTasks!.list(
          {
            workspaceId: f.input.workspaceId,
            roomId: 'room',
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            ...(limit === undefined ? {} : { limit }),
          },
          'owner',
        ),
      );
    const first = read();
    expect(first.roots).toHaveLength(50);
    expect(first.roots[0]).toMatchObject({ authority: 'historical' });
    expect(first.roots.slice(1).every((r) => r.authority === 'current')).toBe(true);
    expect(first.roots.map((r) => r.startSeq)).toEqual([
      53,
      ...receipts
        .slice(2)
        .reverse()
        .map((r) => r.seq),
    ]);
    expect(first.nextBeforeSeq).toBe(receipts[2]!.seq);
    const second = read(first.nextBeforeSeq!);
    expect(second.roots.map((r) => r.rootId)).toEqual(
      receipts
        .slice(0, 2)
        .reverse()
        .map((r) => r.rootId),
    );
    expect(second.roots.map((r) => r.status)).toEqual(['paused', 'completed']);
    expect(second.nextBeforeSeq).toBeNull();
    expect(read(undefined, 1).nextBeforeSeq).toBe(53);
    expect(read(1).roots).toEqual([]);
    expect(read(receipts[50]!.seq).nextBeforeSeq).toBeNull();
    expect(first.roots.map((r) => r.status)).toEqual(
      expect.arrayContaining(['stopped', 'waiting']),
    );
    expect(roomTaskCounts(f)).toEqual(before);
    expect(f.store.conversations.atomic((tx) => tx.chatTurns())).toEqual([]);
    for (const q of [
      { workspaceId: 'foreign', roomId: 'room' },
      { workspaceId: f.input.workspaceId, roomId: 'missing' },
    ])
      expect(() => f.store.conversations.atomic((tx) => tx.roomTasks!.list(q, 'owner'))).toThrow(
        /workspace_conflict|unknown_room/,
      );
  } finally {
    f.close();
  }
});
it('treats exact foreign host and unbound starts as historical without adoption', async () => {
  const f = hostedRoomTasks();
  try {
    const result = f.service.startHosted(f.input);
    if (!result.ok) throw Error('start');
    const read = () => f.store.conversations.atomic((tx) => tx.roomTasks!.list(f.input, 'owner'));
    expect(read().roots[0]?.authority).toBe('current');
    const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
    const { openSqliteStore } = await import('./index.js');
    const reopened = openSqliteStore({ path });
    try {
      reopened.bindRoomHost(
        { ownerId: 'different', epochId: null },
        { origin: null, active: null },
      );
      const before = roomTaskCounts(f);
      expect(
        reopened.conversations.atomic((tx) => tx.roomTasks!.list(f.input, 'owner')).roots[0]
          ?.authority,
      ).toBe('historical');
      expect(roomTaskCounts(f)).toEqual(before);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
it('includes the largest safe start sequence on an unbounded first page and excludes its cursor', () => {
  const f = hostedRoomTasks();
  try {
    f.store.conversations.atomic((tx) =>
      tx.putMessage({
        id: 'prior',
        workspaceId: f.input.workspaceId,
        roomId: 'room',
        seq: Number.MAX_SAFE_INTEGER - 1,
        author: 'user',
        targetBotId: null,
        body: 'prior',
        createdAt: '2026-11-06T00:00:00Z',
      }),
    );
    const started = f.service.startHosted(f.input);
    if (!started.ok) throw Error(started.error.code);
    expect(started.value.seq).toBe(Number.MAX_SAFE_INTEGER);
    const read = (beforeSeq?: number) =>
      f.store.conversations.atomic((tx) =>
        tx.roomTasks!.list(
          {
            workspaceId: f.input.workspaceId,
            roomId: 'room',
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          },
          'owner',
        ),
      );
    expect(read().roots.map((r) => r.startSeq)).toEqual([Number.MAX_SAFE_INTEGER]);
    expect(read(Number.MAX_SAFE_INTEGER).roots).toEqual([]);
  } finally {
    f.close();
  }
});
