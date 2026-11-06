import { expect, it, vi } from 'vitest';
import { roomSlices, answer } from '../test-fixtures/room-slices.js';
it('vetoes a stopped root in the committed-start/stream gap without provider I/O', async () => {
  const f = roomSlices([answer('must never dispatch')]);
  try {
    const start = f.start();
    const original = f.tasks.executeWithDisposition.bind(f.tasks);
    vi.spyOn(f.tasks, 'executeWithDisposition').mockImplementation(async (command) => {
      const result = await original(command);
      if (command.type === 'StartModelRequest' && result.ok)
        f.db!.prepare(
          "UPDATE ocean_room_tasks SET status='stopped',revision=revision+1 WHERE id=?",
        ).run(start.rootId);
      return result;
    });
    await f.execute(start.deliveries[0]!.deliveryId);
    expect(f.requests).toHaveLength(0);
    const events = f
      .db!.prepare(
        "SELECT type,payload FROM events WHERE type IN ('attempt.model_request_started','attempt.model_request_settled') ORDER BY sequence",
      )
      .all();
    expect(events).toHaveLength(2);
    expect(JSON.parse(String(events[1]!['payload']))).toMatchObject({
      completion: { kind: 'not_sent' },
    });
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
it('refuses a fresh model start under the SQLite command lock after the root fence', async () => {
  const f = roomSlices([answer('must never dispatch')]);
  try {
    const start = f.start();
    const commands = f.store.log.commands!;
    const original = commands.commitWithDisposition!.bind(commands);
    vi.spyOn(commands, 'commitWithDisposition').mockImplementation(async (...args) => {
      if (args[0].type === 'StartModelRequest') {
        f.db!.prepare(
          "UPDATE ocean_room_tasks SET status='stopped',revision=revision+1 WHERE id=?",
        ).run(start.rootId);
      }
      return original(...args);
    });
    await f.execute(start.deliveries[0]!.deliveryId);
    expect(f.requests).toHaveLength(0);
    expect(
      f
        .db!.prepare("SELECT count(*) AS n FROM events WHERE type='attempt.model_request_started'")
        .get()?.['n'],
    ).toBe(0);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
it('publishes an already prepared child locally after stop and preserves the parent fence', async () => {
  const { delegate } = await import('../test-fixtures/room-slices.js');
  const { repairRoomHandoff } = await import('@runnets/application');
  const f = roomSlices([delegate('b', 'B work'), answer('B complete')]);
  try {
    const start = f.start(),
      a = await f.execute(start.deliveries[0]!.deliveryId);
    const commands = f.store.log.commands!,
      original = commands.commitWithDisposition!.bind(commands);
    vi.spyOn(commands, 'commitWithDisposition').mockImplementation(async (...args) => {
      if (args[0].type === 'Complete' && args[0].taskRunId !== a.taskRunId) {
        f.store.conversations.atomic((tx) =>
          tx.replaceBot({ ...tx.bot('a')!, profileVersion: 2 }, 1),
        );
        f.db!.prepare(
          "UPDATE ocean_room_tasks SET status='stopped',revision=revision+1 WHERE id=? AND status='ready'",
        ).run(start.rootId);
      }
      return original(...args);
    });
    const b = await f.execute(a.roomHandoff!.deliveryId);
    const repaired = await repairRoomHandoff(f.deps, b.id);
    expect(repaired?.status).toBe('completed');
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.rootId)?.status)).toBe(
      'stopped',
    );
    const result = f.deliveries(a.roomDelivery!.taskId).find((d) => d.kind === 'result')!;
    expect(result).toBeDefined();
    expect(f.claim(result.id).kind).toBe('held');
    expect(f.requests).toHaveLength(2);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
it('rechecks each actual issuer pin before dispatching the child', async () => {
  const { delegate } = await import('../test-fixtures/room-slices.js');
  const f = roomSlices([delegate('b', 'B work')]);
  try {
    const a = await f.execute(f.start().deliveries[0]!.deliveryId);
    f.store.conversations.atomic((tx) => tx.replaceBot({ ...tx.bot('a')!, profileVersion: 2 }, 1));
    expect(f.claim(a.roomHandoff!.deliveryId).kind).toBe('held');
    expect(f.requests).toHaveLength(1);
  } finally {
    f.close();
  }
});
it('pauses exactly the third normalized duplicate exchange without a child or message', async () => {
  const { delegate } = await import('../test-fixtures/room-slices.js');
  const f = roomSlices(
    [
      delegate('b', ' café '),
      delegate('a', 'repeat'),
      delegate('b', 'cafe\u0301'),
      delegate('a', 'repeat'),
      delegate('b', 'café'),
    ],
    [],
  );
  try {
    const start = f.start();
    const collision = 'room-fence/v1:' + f.deps.sha256(start.rootId);
    const owner = f.service.startHosted({ ...f.input, requestId: collision });
    expect(owner.ok).toBe(true);
    let delivery = start.deliveries[0]!.deliveryId;
    for (let i = 0; i < 5; i++) {
      const turn = await f.execute(delivery);
      if (turn.roomHandoff) delivery = turn.roomHandoff.deliveryId;
    }
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.rootId)?.status)).toBe(
      'paused',
    );
    expect(
      f
        .db!.prepare("SELECT count(*) AS n FROM ocean_room_deliveries WHERE kind='delegate'")
        .get()?.['n'],
    ).toBe(4);
    expect(
      f
        .db!.prepare(
          "SELECT count(*) AS n FROM ocean_receipts WHERE json_extract(reply,'$.kind')='room_task_fence'",
        )
        .get()?.['n'],
    ).toBe(1);
    expect(f.requests).toHaveLength(5);
    expect(f.store.conversations.atomic((tx) => tx.receipt(collision)?.reply.kind)).toBe('message');
  } finally {
    f.close();
  }
});

it.each(['receipt', 'attempt'] as const)(
  'rechecks historical assignment %s after child start commits',
  async (fault) => {
    const { delegate } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([delegate('b', 'work'), answer('must not send')]);
    try {
      const start = f.start(),
        a = await f.execute(start.deliveries[0]!.deliveryId);
      let injected = 0;
      const original = f.tasks.executeWithDisposition.bind(f.tasks);
      vi.spyOn(f.tasks, 'executeWithDisposition').mockImplementation(async (command) => {
        const result = await original(command);
        if (command.type === 'StartModelRequest' && result.ok) {
          f.db!.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER ocean_room_delivery_immutable');
          if (fault === 'receipt')
            f.db!.prepare('DELETE FROM ocean_receipts WHERE request_id=?').run(f.input.requestId);
          else
            f.db!.prepare(
              "UPDATE ocean_room_deliveries SET source_attempt_id='contradictory' WHERE id=?",
            ).run(a.roomHandoff!.deliveryId);
          injected++;
          f.db!.exec('PRAGMA foreign_keys=ON');
        }
        return result;
      });
      await f.execute(a.roomHandoff!.deliveryId);
      expect(injected).toBe(1);
      expect(f.requests).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  },
);
