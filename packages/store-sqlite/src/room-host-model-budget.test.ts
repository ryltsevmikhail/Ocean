import { expect, it, vi } from 'vitest';
import { roomSlices, answer, usage } from '../test-fixtures/room-slices.js';
import type { ProviderEvent } from '@runnets/application';
it('charges64 actual starts, permits the last completion and freezes only the next eligible start', async () => {
  const rounds: ProviderEvent[][] = [];
  const f = roomSlices(rounds, []);
  try {
    const start = f.start();
    expect(
      f.service.startHosted({
        ...f.input,
        requestId: 'room-fence/v1:' + f.deps.sha256(start.rootId),
      }).ok,
    ).toBe(true);
    let delivery = start.deliveries[0]!.deliveryId;
    for (let index = 0; index < 16; index++) {
      const input = f.store.conversations.atomic((tx) => tx.roomTasks!.delivery(delivery))!;
      for (let ordinal = 1; ordinal < 4; ordinal++)
        rounds.push([
          {
            type: 'tool_call',
            call: {
              id: 'call',
              name: ordinal === 1 ? 'room_send' : 'room_state',
              arguments: JSON.stringify(
                ordinal === 1
                  ? { toBotId: index % 2 === 0 ? 'b' : 'a', text: 'next ' + index }
                  : { taskId: input.toTaskId },
              ),
            },
          },
          usage,
          { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
        ]);
      rounds.push([...answer('last completion')]);
      expect((await f.execute(delivery)).status).toBe('completed');
      const child = f.store.conversations.atomic((tx) =>
        tx
          .roomTasks!.tasks(start.rootId)
          .find((t) => t.kind === 'bot' && t.parentId === input.toTaskId),
      )!;
      delivery = f.deliveries(child.id)[0]!.id;
    }
    await f.execute(delivery);
    expect(f.requests).toHaveLength(64);
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.projection(start.rootId)),
    ).toMatchObject({
      status: 'paused',
      fenceReason: { code: 'model_limit' },
      counts: { modelStarts: 64 },
    });
  } finally {
    f.close();
  }
});
it('vetoes a newly discovered unscoped unknown in the committed-start/send gap', async () => {
  const f = roomSlices([answer('no send')]);
  try {
    const original = f.tasks.executeWithDisposition.bind(f.tasks);
    vi.spyOn(f.tasks, 'executeWithDisposition').mockImplementation(async (command) => {
      const result = await original(command);
      if (command.type === 'StartModelRequest' && result.ok)
        f.db!.exec("INSERT INTO tool_invocations_v1 VALUES('unknown','legacy','uncertain')");
      return result;
    });
    await f.execute(f.start().deliveries[0]!.deliveryId);
    expect(f.requests).toHaveLength(0);
    expect(
      f
        .db!.prepare("SELECT count(*) AS n FROM events WHERE type='attempt.model_request_started'")
        .get()?.['n'],
    ).toBe(1);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
