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
