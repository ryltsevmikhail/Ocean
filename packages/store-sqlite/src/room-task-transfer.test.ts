import { expect, it } from 'vitest';
import { RoomModelPolicyService, unconfiguredModelConnection } from '@runnets/application';
import { hostedRoomTasks, attachRoomActor, roomTaskCounts } from '../test-fixtures/room-tasks.js';
function localPolicy(f: ReturnType<typeof hostedRoomTasks>) {
  f.store.modelConnections.put(
    {
      ...unconfiguredModelConnection('fixture'),
      connectionId: 'local',
      kind: 'local',
      auth: 'none',
      endpoint: 'http://127.0.0.1:1234',
      revision: 1,
      intent: 'disconnected',
    },
    null,
  );
  f.store.conversations.atomic((tx) => {
    for (const bot of ['a', 'b', 'c'])
      tx.putModelBinding(bot, { connectionId: 'local', modelId: 'one' });
  });
  return {
    service: new RoomModelPolicyService({
      store: f.store.conversations,
      connections: f.store.modelConnections,
    }),
    input: {
      workspaceId: f.input.workspaceId,
      roomId: 'room',
      requestId: 'deny',
      expectedRevision: 1,
      cloudTransfer: 'deny' as const,
    },
  };
}
it('blocks privacy policy lowering for runnable frozen queued cloud pins after local rebind', () => {
  const f = hostedRoomTasks();
  try {
    expect(f.service.startHosted(f.input).ok).toBe(true);
    const policy = localPolicy(f),
      before = roomTaskCounts(f);
    expect(policy.service.set(policy.input)).toMatchObject({
      ok: false,
      error: { code: 'model_policy_work_conflict' },
    });
    expect(roomTaskCounts(f)).toEqual(before);
  } finally {
    f.close();
  }
});
it.each([
  { row: 'root', status: 'stopped' },
  { row: 'root', status: 'completed' },
  { row: 'task', status: 'stopped' },
  { row: 'task', status: 'completed' },
])('permits privacy deny for a never-claimed queue under $row=$status', ({ row, status }) => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted({ ...f.input, initialBotIds: ['a'] });
    if (!start.ok) throw Error('start');
    const policy = localPolicy(f);
    expect(policy.service.set({ ...policy.input, requestId: 'before-stop' })).toMatchObject({
      ok: false,
      error: { code: 'model_policy_work_conflict' },
    });
    expect(f.store.conversations.atomic((tx) => tx.chatTurns())).toEqual([]);
    f.db!.prepare('UPDATE ocean_room_tasks SET status=? WHERE id=?').run(
      status,
      row === 'root' ? start.value.rootId : start.value.deliveries[0]!.taskId,
    );
    const before = roomTaskCounts(f);
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.pendingTransfer('room'))).toBe(false);
    expect(policy.service.set(policy.input)).toMatchObject({
      ok: true,
      value: { cloudTransfer: 'deny', revision: 2 },
    });
    expect(roomTaskCounts(f)).toEqual({ ...before, ocean_receipts: before['ocean_receipts']! + 1 });
    expect(f.db!.prepare('SELECT state FROM ocean_room_deliveries').get()?.['state']).toBe(
      'queued',
    );
  } finally {
    f.close();
  }
});
it('retains the privacy barrier for a stopped unresolved claim even after its chat becomes terminal', async () => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted({ ...f.input, initialBotIds: ['a'] });
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      policy = localPolicy(f);
    f.db!.prepare("UPDATE ocean_room_tasks SET status='stopped' WHERE id=?").run(
      start.value.rootId,
    );
    const before = roomTaskCounts(f);
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.pendingTransfer('room'))).toBe(true);
    expect(policy.service.set(policy.input)).toMatchObject({
      ok: false,
      error: { code: 'model_policy_work_conflict' },
    });
    expect(roomTaskCounts(f)).toEqual(before);
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.putChatTurn({ ...tx.chatTurn(actor.turnId)!, status: 'completed' }),
      ),
    ).toThrow('invalid room slice');
    // Synthetic terminal ChatTurn only; the unresolved privacy barrier must remain.
    f.store.conversations.atomic((tx) =>
      tx.putChatTurn({ ...tx.chatTurn(actor.turnId)!, status: 'cancelled' }),
    );
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.pendingTransfer('room'))).toBe(true);
    expect(policy.service.set(policy.input)).toMatchObject({
      ok: false,
      error: { code: 'model_policy_work_conflict' },
    });
  } finally {
    f.close();
  }
});

it('refuses private-room cloud transfers without writes', async () => {
  const f = hostedRoomTasks();
  try {
    f.store.conversations.atomic((tx) =>
      tx.putRoomModelPolicy({ roomId: 'room', cloudTransfer: 'deny', revision: 2 }),
    );
    const before = roomTaskCounts(f);
    expect(f.service.startHosted(f.input)).toMatchObject({
      ok: false,
      error: { code: 'model_transfer_denied' },
    });
    expect(roomTaskCounts(f)).toEqual(before);
    f.store.conversations.atomic((tx) =>
      tx.putRoomModelPolicy({ roomId: 'room', cloudTransfer: 'allow', revision: 3 }),
    );
    const started = f.service.startHosted(f.input);
    if (!started.ok) throw Error('start');
    const actor = await attachRoomActor(f, started.value);
    f.store.conversations.atomic((tx) =>
      tx.putRoomModelPolicy({ roomId: 'room', cloudTransfer: 'deny', revision: 4 }),
    );
    const prior = roomTaskCounts(f);
    expect(f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'private' })).toMatchObject(
      { ok: false, error: { code: 'model_transfer_denied' } },
    );
    expect(roomTaskCounts(f)).toEqual(prior);
  } finally {
    f.close();
  }
});
