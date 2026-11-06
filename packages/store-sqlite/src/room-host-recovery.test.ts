import { expect, it } from 'vitest';
import * as application from '@runnets/application';
import { taskRunId } from '@runnets/domain';
import { roomSlices } from '../test-fixtures/room-slices.js';
it('exempts only exactly unstarted same-ID room claims before generic reconciliation', async () => {
  const f = roomSlices([]);
  try {
    const start = f.start(),
      claim = f.claim(start.deliveries[0]!.deliveryId);
    if (claim.kind !== 'claimed') throw Error('claim');
    await f.tasks.execute(application.createChatCommand(claim.turn, claim.parentRunId));
    await application.reconcileInterrupted(f.tasks, f.store.tools, (id) =>
      application.unstartedRoomClaimRuns(f.deps).includes(id),
    );
    expect((await f.tasks.state(taskRunId(claim.turn.taskRunId))).status).toBe('created');
    expect(application.recoverUnstartedRoomClaims(f.deps).map((c) => c.turn.id)).toEqual([
      claim.turn.id,
    ]);
  } finally {
    f.close();
  }
});
