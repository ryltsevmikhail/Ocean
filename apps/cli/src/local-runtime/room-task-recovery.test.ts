import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeRoomTasks } from './room-tasks.js';
import { roomSlices, answer } from '../../../../packages/store-sqlite/test-fixtures/room-slices.js';
it('starts both persisted recoverable claims with one trusted slot without stranding the overflow', async () => {
  const f = roomSlices([answer('first'), answer('second')]);
  const start = f.service.startHosted(f.input);
  if (!start.ok) throw Error('start');
  const claims = start.value.deliveries.map((d) => f.claim(d.deliveryId));
  expect(claims.every((c) => c.kind === 'claimed')).toBe(true);
  const original = f.turns().map((t) => [t.id, t.taskRunId, t.activation]);
  const supervisor = new RuntimeRoomTasks(
    f.service,
    f.deps,
    f.deps,
    f.store.openRoomReads(Date.now),
    'restart',
    1,
  );
  try {
    supervisor.start();
    const deadline = Date.now() + 2000;
    while (f.turns().some((t) => t.status !== 'completed') && Date.now() < deadline) await delay(5);
    expect(f.turns().map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(f.turns().map((t) => [t.id, t.taskRunId, t.activation])).toEqual(original);
    expect(f.requests).toHaveLength(2);
    supervisor.start();
    await delay(20);
    expect(f.requests).toHaveLength(2);
  } finally {
    await supervisor.drain();
    f.close();
  }
});
