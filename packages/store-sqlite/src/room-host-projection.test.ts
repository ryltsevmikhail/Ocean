import { expect, it } from 'vitest';
import { roomSlices, answer } from '../test-fixtures/room-slices.js';
it('withholds unproved room result references when the exact Complete receipt is missing', async () => {
  const f = roomSlices([answer('answer')]);
  try {
    const start = f.start(),
      turn = await f.execute(start.deliveries[0]!.deliveryId);
    f.db!.prepare(
      "DELETE FROM command_receipts WHERE aggregate_id=? AND command_id LIKE '%_Complete_%'",
    ).run(turn.taskRunId);
    const view = f.store.conversations.atomic((tx) => tx.roomTasks!.projection(start.rootId));
    expect(view?.rows.find((r) => r.type === 'slice')).toMatchObject({
      resultMessageId: null,
      hold: 'unknown',
    });
  } finally {
    f.close();
  }
});
it('preserves genuine legacy v1 pause evidence without rewriting its receipt or public ID', async () => {
  const { freezeRoomTask } = await import('@runnets/application');
  const { canonicalJson } = await import('@runnets/domain');
  const f = roomSlices([]);
  try {
    const start = f.start(),
      id = 'room-fence/v1:' + f.deps.sha256(start.rootId);
    f.store.conversations.atomic((tx) => {
      const root = tx.roomTasks!.task(start.rootId);
      if (root?.kind !== 'root') throw Error('root');
      tx.putReceipt(id, {
        binding: canonicalJson(['RoomTaskFence/v1', root.id, 'duplicate_exchange']),
        reply: {
          kind: 'room_task_fence',
          data: {
            workspaceId: root.workspaceId,
            roomId: root.roomId,
            rootId: root.id,
            id,
            code: 'duplicate_exchange',
            revision: 2,
          },
        },
      });
      tx.roomTasks!.advanceTask({ ...root, status: 'paused' }, 1);
      freezeRoomTask(tx, { ...root, status: 'paused', revision: 2 }, 'model_limit', f.deps.sha256);
    });
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.projection(start.rootId)),
    ).toMatchObject({
      status: 'paused',
      revision: 2,
      fenceReason: { id, code: 'duplicate_exchange' },
    });
    expect(
      f
        .db!.prepare(
          "SELECT count(*) AS n FROM ocean_receipts WHERE json_extract(reply,'$.kind')='room_task_fence'",
        )
        .get()?.['n'],
    ).toBe(1);
  } finally {
    f.close();
  }
});
