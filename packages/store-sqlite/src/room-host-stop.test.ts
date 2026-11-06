import { expect, it } from 'vitest';
import {
  stopRoomTask,
  createChatCommand,
  executeChatTurn,
  releaseUnstartedRoomClaim,
} from '@runnets/application';
import { roomSlices } from '../test-fixtures/room-slices.js';
it.each(['absent', 'created'] as const)(
  'releases only a joined proven %s accepted hold after stop without consuming input',
  async (phase) => {
    const f = roomSlices([]);
    try {
      const start = f.start(),
        claim = f.claim(start.deliveries[0]!.deliveryId);
      if (claim.kind !== 'claimed') throw Error('claim');
      if (phase === 'created') await f.tasks.execute(createChatCommand(claim.turn, null));
      stopRoomTask(f.store.conversations, 'owner', {
        workspaceId: f.input.workspaceId,
        roomId: 'room',
        rootId: start.rootId,
        requestId: 'stop',
        expectedRevision: 1,
      });
      expect(await releaseUnstartedRoomClaim(f.deps, claim.turn.id)).toBe(true);
      expect(f.turns()[0]?.status).toBe('cancelled');
      expect(f.deliveries(claim.turn.roomDelivery!.taskId)[0]?.state).toBe('claimed');
      expect(f.requests).toHaveLength(0);
      expect(f.store.conversations.atomic((tx) => tx.roomTasks!.counts(start.rootId).active)).toBe(
        0,
      );
    } finally {
      f.close();
    }
  },
);
it('cancels a marked executor before any preparation or model start under a stopped root', async () => {
  const f = roomSlices([]);
  try {
    const start = f.start(),
      c = f.claim(start.deliveries[0]!.deliveryId);
    if (c.kind !== 'claimed') throw Error('claim');
    stopRoomTask(f.store.conversations, 'owner', {
      workspaceId: f.input.workspaceId,
      roomId: 'room',
      rootId: start.rootId,
      requestId: 'stop',
      expectedRevision: 1,
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      (await executeChatTurn(f.deps, { ...c, signal: controller.signal, emit() {} }, c)).status,
    ).toBe('cancelled');
    expect(f.requests).toHaveLength(0);
  } finally {
    f.close();
  }
});
it.each(['absent', 'created'] as const)(
  'releases a never-started %s message child after issuer removal with its exact input proof',
  async (phase) => {
    const { usage, answer } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([
      [
        {
          type: 'tool_call',
          call: { id: 'send', name: 'room_send', arguments: '{"toBotId":"b","text":"work"}' },
        },
        usage,
        { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
      ],
      answer('A done'),
    ]);
    try {
      const start = f.start(),
        a = await f.execute(start.deliveries[0]!.deliveryId);
      const child = f.store.conversations.atomic((tx) =>
        tx.roomTasks!.tasks(start.rootId).find((t) => t.kind === 'bot' && t.assigneeBotId === 'b'),
      )!;
      const input = f.deliveries(child.id)[0]!,
        receipt = f.store.conversations.atomic((tx) => tx.receipt(input.requestKey));
      expect(input.kind).toBe('message');
      expect(child).toMatchObject({ parentId: a.roomDelivery!.taskId, waitingChildId: null });
      const claim = f.claim(input.id);
      if (claim.kind !== 'claimed') throw Error('claim');
      if (phase === 'created')
        await f.tasks.execute(createChatCommand(claim.turn, claim.parentRunId));
      const parent = f.store.conversations.atomic((tx) =>
        tx.roomTasks!.task(a.roomDelivery!.taskId),
      );
      f.db!.exec('PRAGMA foreign_keys=OFF');
      expect(
        f.db!.prepare("DELETE FROM ocean_members WHERE room_id='room' AND bot_id='a'").run()
          .changes,
      ).toBe(1);
      f.db!.exec('PRAGMA foreign_keys=ON');
      stopRoomTask(f.store.conversations, 'owner', {
        workspaceId: f.input.workspaceId,
        roomId: 'room',
        rootId: start.rootId,
        requestId: 'stop',
        expectedRevision: 1,
      });
      expect(await releaseUnstartedRoomClaim(f.deps, claim.turn.id)).toBe(true);
      expect(f.store.conversations.atomic((tx) => tx.chatTurn(claim.turn.id)?.status)).toBe(
        'cancelled',
      );
      expect(f.deliveries(child.id)[0]).toEqual({ ...input, state: 'claimed' });
      expect(f.store.conversations.atomic((tx) => tx.receipt(input.requestKey))).toEqual(receipt);
      expect(
        f.store.conversations.atomic((tx) => tx.roomTasks!.task(a.roomDelivery!.taskId)),
      ).toEqual(parent);
      expect(f.requests).toHaveLength(2);
      expect(
        f
          .db!.prepare(
            "SELECT count(*) AS n FROM events WHERE aggregate_id=? AND type='attempt.started'",
          )
          .get(claim.turn.taskRunId)?.['n'],
      ).toBe(0);
    } finally {
      f.close();
    }
  },
);
it.each(['delegate', 'result'] as const)(
  'retains the exact %s wait/input joins for never-started proof-only release',
  async (kind) => {
    const { delegate, answer } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([delegate('b', 'work'), answer('B done')]);
    try {
      const start = f.start(),
        a = await f.execute(start.deliveries[0]!.deliveryId);
      let delivery = a.roomHandoff!.deliveryId;
      if (kind === 'result') {
        await f.execute(delivery);
        delivery = f.deliveries(a.roomDelivery!.taskId).find((d) => d.kind === 'result')!.id;
      }
      const claim = f.claim(delivery);
      if (claim.kind !== 'claimed') throw Error('claim');
      await f.tasks.execute(createChatCommand(claim.turn, claim.parentRunId));
      if (kind === 'delegate')
        f.db!.prepare(
          "UPDATE ocean_room_tasks SET status='ready',waiting_child_id=NULL,revision=revision+1 WHERE id=?",
        ).run(a.roomDelivery!.taskId);
      else {
        const input = f.deliveries(claim.turn.roomDelivery!.taskId).find((d) => d.id === delivery)!;
        f.db!.prepare(
          "UPDATE ocean_receipts SET binding='contradictory result input' WHERE request_id=?",
        ).run(input.requestKey);
      }
      stopRoomTask(f.store.conversations, 'owner', {
        workspaceId: f.input.workspaceId,
        roomId: 'room',
        rootId: start.rootId,
        requestId: 'stop',
        expectedRevision: 1,
      });
      expect(await releaseUnstartedRoomClaim(f.deps, claim.turn.id)).toBe(false);
      expect(f.store.conversations.atomic((tx) => tx.chatTurn(claim.turn.id)?.status)).toBe(
        'accepted',
      );
      expect(
        f.deliveries(claim.turn.roomDelivery!.taskId).find((d) => d.id === delivery)?.state,
      ).toBe('claimed');
      expect(f.requests).toHaveLength(kind === 'delegate' ? 1 : 2);
    } finally {
      f.close();
    }
  },
);
