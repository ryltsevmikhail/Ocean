import { expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { AnyCommand } from '@runnets/domain';
import type { ProviderEvent } from '@runnets/application';
import { roomSlices, usage, answer } from '../test-fixtures/room-slices.js';
it('serializes two runs competing for model start64 and replays only the exact winning command', async () => {
  const rounds: ProviderEvent[][] = [],
    f = roomSlices(rounds, []);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const commands: Extract<AnyCommand, { type: 'StartModelRequest' }>[] = [],
    winners: typeof commands = [];
  const original = f.tasks.executeWithDisposition.bind(f.tasks);
  try {
    const start = f.service.startHosted({ ...f.input, initialBotIds: ['a', 'c'] });
    if (!start.ok) throw Error('start');
    let delivery = start.value.deliveries[0]!.deliveryId;
    vi.spyOn(f.tasks, 'executeWithDisposition').mockImplementation(async (command) => {
      if (
        command.type === 'StartModelRequest' &&
        f
          .db!.prepare(
            "SELECT count(*) AS n FROM events WHERE type='attempt.model_request_started'",
          )
          .get()?.['n'] === 63
      ) {
        commands.push(command);
        await gate;
        const result = await original(command);
        if (result.ok && result.value.disposition === 'committed') winners.push(command);
        return result;
      }
      return original(command);
    });
    const prepare = (index: number, taskId: string) => {
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
                  : { taskId },
              ),
            },
          },
          usage,
          { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
        ]);
      rounds.push([...answer('finished')]);
    };
    for (let index = 0; index < 15; index++) {
      const input = f.store.conversations.atomic((tx) => tx.roomTasks!.delivery(delivery))!;
      prepare(index, input.toTaskId);
      const turn = await f.execute(delivery),
        child = f.store.conversations.atomic((tx) =>
          tx
            .roomTasks!.tasks(start.value.rootId)
            .find((t) => t.parentId === turn.roomDelivery!.taskId),
        )!;
      delivery = f.deliveries(child.id)[0]!.id;
    }
    const input = f.store.conversations.atomic((tx) => tx.roomTasks!.delivery(delivery))!;
    prepare(15, input.toTaskId);
    const last = f.execute(delivery);
    for (let i = 0; commands.length < 1 && i < 200; i++) await delay(5);
    expect(commands).toHaveLength(1);
    const other = f.execute(start.value.deliveries[1]!.deliveryId);
    for (let i = 0; commands.length < 2 && i < 200; i++) await delay(5);
    expect(commands).toHaveLength(2);
    release();
    await Promise.all([last, other]);
    expect(winners).toHaveLength(1);
    expect(f.requests.length).toBeGreaterThanOrEqual(63);
    expect(f.requests.length).toBeLessThanOrEqual(64);
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.projection(start.value.rootId)),
    ).toMatchObject({
      status: 'paused',
      counts: { modelStarts: 64 },
      fenceReason: { code: 'model_limit' },
    });
    expect(await original(winners[0]!)).toMatchObject({
      ok: true,
      value: { disposition: 'replayed' },
    });
    const winner = winners[0]!;
    expect(
      await original({
        ...winner,
        payload: { ...winner.payload, ordinal: winner.payload.ordinal + 1 },
      }),
    ).toMatchObject({ ok: false });
    expect(
      f
        .db!.prepare("SELECT count(*) AS n FROM events WHERE type='attempt.model_request_started'")
        .get()?.['n'],
    ).toBe(64);
  } finally {
    release();
    vi.restoreAllMocks();
    f.close();
  }
});
