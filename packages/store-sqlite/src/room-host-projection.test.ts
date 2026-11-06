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
