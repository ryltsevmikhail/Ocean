import type { ProviderEvent } from '@runnets/application';
import { expect, it } from 'vitest';
import { roomTasks } from '../test-fixtures/room-tasks.js';
import { roomSlices } from '../test-fixtures/room-slices.js';

it('ordinary admissions remain inert, including application claim calls', () => {
  const f = roomSlices([]);
  try {
    const admitted = f.service.start(f.input);
    if (!admitted.ok) throw Error('inert start');
    const start = admitted.value;
    expect(f.claim(start.deliveries[0]!.deliveryId).kind).toBe('held');
    expect(f.turns()).toEqual([]);
  } finally {
    f.close();
  }
});
it('hosted admission requires a bound host and stamps only fresh roots', () => {
  const f = roomTasks();
  try {
    const hosted = f.service.startHosted.bind(f.service);
    expect(hosted(f.input)).toMatchObject({ ok: false });
    f.store.bindRoomHost({ ownerId: 'owner', epochId: null }, { origin: null, active: null });
    const start = hosted(f.input);
    expect(start.ok).toBe(true);
    if (!start.ok) throw Error('start');
    expect(
      f.db!.prepare('SELECT host_scope FROM ocean_room_tasks WHERE id=?').get(start.value.rootId)?.[
        'host_scope'
      ],
    ).toBe(JSON.stringify({ ownerId: 'owner', epochId: null }));
    expect(hosted(f.input)).toEqual(start);
    expect(hosted({ ...f.input, text: 'altered' })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    expect(() =>
      f
        .db!.prepare('UPDATE ocean_room_tasks SET host_scope=NULL WHERE id=?')
        .run(start.value.rootId),
    ).toThrow();
  } finally {
    f.close();
  }
});
it('room_state returns only verified related task metadata and journals its one local charge', async () => {
  const { usage, answer } = await import('../test-fixtures/room-slices.js');
  const rounds: ProviderEvent[][] = [];
  const f = roomSlices(rounds, []);
  try {
    const start = f.start(),
      taskId = start.deliveries[0]!.taskId;
    rounds.push(
      [
        {
          type: 'tool_call',
          call: { id: 'state', name: 'room_state', arguments: JSON.stringify({ taskId }) },
        },
        usage,
        { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
      ],
      [...answer('done')],
    );
    await f.execute(start.deliveries[0]!.deliveryId);
    expect(
      f.requests[1]!.messages.filter((m) => m.role === 'tool')
        .map((m) => m.content)
        .join(),
    ).toContain('"status":"ready"');
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.counts(start.rootId).toolCalls)).toBe(
      1,
    );
    expect(f.db!.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(0);
  } finally {
    f.close();
  }
});
