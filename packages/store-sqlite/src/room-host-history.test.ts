import { expect, it } from 'vitest';
import { ServiceCallAdmissionService } from '@runnets/application';
import { roomServiceSlices } from '../test-fixtures/room-slices.js';
import { attachRoomActor } from '../test-fixtures/room-tasks.js';
it.each(['receipt', 'attempt'] as const)(
  'rechecks historical %s at the actual C dispatch after its claim',
  async (fault) => {
    const f = roomServiceSlices();
    try {
      const start = f.startService(),
        a = await attachRoomActor(f, start);
      const child = f.service.send(a, { kind: 'message', toBotId: 'b', text: 'work' });
      if (!child.ok) throw Error('child');
      const b = await attachRoomActor(f, child.value, 'b');
      let sends = 0,
        entries = 0;
      const service = new ServiceCallAdmissionService({
        store: f.store.serviceAuthority,
        now: () => f.deps.clock.now().getTime(),
        restored: false,
        transport: {
          async invoke(input) {
            entries++;
            f.db!.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER ocean_room_delivery_immutable');
            if (fault === 'receipt')
              f.db!.prepare('DELETE FROM ocean_receipts WHERE request_id=?').run(f.input.requestId);
            else
              f.db!.prepare(
                "UPDATE ocean_room_deliveries SET source_attempt_id='contradictory' WHERE id=?",
              ).run(child.value.deliveries[0]!.deliveryId);
            f.db!.exec('PRAGMA foreign_keys=ON');
            if (input.authorizeDispatch()) sends++;
            return {
              kind: 'not_started',
              code: 'execution_disabled',
              invocationId: input.invocationId,
              detail: 'denied',
            };
          },
        },
      });
      await service.call(f.request(b, 'b'));
      expect(entries).toBe(1);
      expect(sends).toBe(0);
      expect(f.db!.prepare('SELECT outcome FROM tool_invocations_v2').get()?.['outcome']).toBe(
        'not_started',
      );
    } finally {
      f.close();
    }
  },
);
it('holds a fresh child claim when its ancestor receipt was corrupted before admission', async () => {
  const { roomSlices, delegate } = await import('../test-fixtures/room-slices.js');
  const f = roomSlices([delegate('b', 'work')]);
  try {
    const a = await f.execute(f.start().deliveries[0]!.deliveryId);
    f.db!.prepare("UPDATE ocean_receipts SET binding='contradictory' WHERE request_id=?").run(
      f.input.requestId,
    );
    expect(f.claim(a.roomHandoff!.deliveryId).kind).toBe('held');
    expect(f.requests).toHaveLength(1);
    expect(f.turns()).toHaveLength(1);
  } finally {
    f.close();
  }
});
