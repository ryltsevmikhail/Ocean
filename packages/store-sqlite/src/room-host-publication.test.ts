import { expect, it, vi } from 'vitest';
import {
  repairRoomHandoff,
  releaseUnstartedRoomClaim,
  stopRoomTask,
  createChatCommand,
} from '@runnets/application';
import { roomServiceSlices, roomSlices, delegate, answer } from '../test-fixtures/room-slices.js';
it('publishes an exact completed child once after grant expiry, connection rotation and stop', async () => {
  const f = roomServiceSlices(10, 'autonomous', [delegate('b', 'work'), answer('known result')]);
  try {
    const grants = f.grants.map((g) => ({
      ...g,
      revision: 2,
      limits: {
        ...g.limits,
        expiresAt: new Date(f.deps.clock.now().getTime() + 1000).toISOString(),
      },
    }));
    f.store.serviceAuthority.atomic((tx) => {
      for (const g of grants) tx.putGrant(g, 1);
    });
    const started = f.service.startHosted({
      ...f.input,
      initialBotIds: ['a'],
      participants: grants.map((g) => ({
        botId: g.subject.botId,
        grantReferences: [{ grantId: g.id, revision: 2 }],
      })),
      mandate: { projectId: null, codingTaskId: null, permissions: grants[0]!.permissions },
    });
    if (!started.ok) throw Error(started.error.code);
    let injected = 0;
    const start = started.value,
      a = await f.execute(start.deliveries[0]!.deliveryId),
      commands = f.store.log.commands!,
      original = commands.commitWithDisposition!.bind(commands);
    vi.spyOn(commands, 'commitWithDisposition').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0].type === 'Complete' && args[0].taskRunId !== a.taskRunId && result.ok) {
        injected++;
        f.advance(1001);
        const connection = f.store.modelConnections.read('cloud')!;
        f.store.modelConnections.put(
          { ...connection, revision: connection.revision + 1 },
          connection.revision,
        );
        f.db!.prepare(
          "UPDATE ocean_room_tasks SET status='stopped',revision=revision+1 WHERE id=?",
        ).run(start.rootId);
      }
      return result;
    });
    const b = await f.execute(a.roomHandoff!.deliveryId);
    expect(injected).toBe(1);
    expect(f.deps.clock.now().getTime()).toBeGreaterThan(Date.parse(grants[0]!.limits.expiresAt!));
    expect(f.store.modelConnections.read('cloud')?.revision).toBe(2);
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.rootId)?.status)).toBe(
      'stopped',
    );
    expect(b.status).toBe('completed');
    expect((await repairRoomHandoff(f.deps, b.id))?.status).toBe('completed');
    expect((await repairRoomHandoff(f.deps, b.id))?.status).toBe('completed');
    expect(f.deliveries(a.roomDelivery!.taskId).filter((d) => d.kind === 'result')).toHaveLength(1);
    const result = f.deliveries(a.roomDelivery!.taskId).find((d) => d.kind === 'result')!;
    expect(f.claim(result.id).kind).toBe('held');
    expect(f.requests).toHaveLength(2);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
it('releases exact never-started stop evidence after sender authority changes with zero I/O', async () => {
  const f = roomSlices([]);
  try {
    const start = f.start(),
      claim = f.claim(start.deliveries[0]!.deliveryId);
    if (claim.kind !== 'claimed') throw Error('claim');
    await f.tasks.execute(createChatCommand(claim.turn, null));
    f.store.conversations.atomic((tx) => tx.replaceBot({ ...tx.bot('a')!, profileVersion: 2 }, 1));
    stopRoomTask(f.store.conversations, 'owner', {
      workspaceId: f.input.workspaceId,
      roomId: 'room',
      rootId: start.rootId,
      requestId: 'stop',
      expectedRevision: 1,
    });
    expect(await releaseUnstartedRoomClaim(f.deps, claim.turn.id)).toBe(true);
    expect(f.turns()[0]?.status).toBe('cancelled');
    expect(f.requests).toHaveLength(0);
  } finally {
    f.close();
  }
});
it('publishes prepared message-edge work after issuer membership removal while fresh execution stays held', async () => {
  const { usage } = await import('../test-fixtures/room-slices.js');
  const f = roomSlices(
    [
      [
        ...['b', 'c'].map((toBotId) => ({
          type: 'tool_call' as const,
          call: {
            id: toBotId,
            name: 'room_send',
            arguments: JSON.stringify({ toBotId, text: 'work ' + toBotId }),
          },
        })),
        usage,
        { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
      ],
      answer('A done'),
      answer('B done'),
    ],
    ['b', 'c'],
  );
  try {
    const start = f.start();
    await f.execute(start.deliveries[0]!.deliveryId);
    const children = f.store.conversations.atomic((tx) =>
      tx.roomTasks!.tasks(start.rootId).filter((t) => t.kind === 'bot'),
    );
    const b = children.find((t) => t.kind === 'bot' && t.assigneeBotId === 'b')!,
      c = children.find((t) => t.kind === 'bot' && t.assigneeBotId === 'c')!;
    let removed = 0;
    const seen: string[] = [];
    const commands = f.store.log.commands!,
      original = commands.commitWithDisposition!.bind(commands);
    vi.spyOn(commands, 'commitWithDisposition').mockImplementation(async (...args) => {
      const result = await original(...args);
      seen.push(args[0].type + ':' + result.ok);
      if (args[0].type === 'Complete' && result.ok) {
        f.db!.exec('PRAGMA foreign_keys=OFF');
        removed += Number(
          f.db!.prepare("DELETE FROM ocean_members WHERE room_id='room' AND bot_id='a'").run()
            .changes,
        );
        f.db!.exec('PRAGMA foreign_keys=ON');
      }
      return result;
    });
    const completed = await f.execute(f.deliveries(b.id)[0]!.id);
    expect(removed, seen.join(',')).toBe(1);
    expect(
      f.store.conversations.atomic((tx) =>
        tx.room('room')?.kind === 'group' ? tx.room('room') : null,
      ),
    ).toMatchObject({ botIds: ['b', 'c'] });
    expect(completed.status).toBe('completed');
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.rootId)?.status)).toBe(
      'ready',
    );
    expect(f.claim(f.deliveries(c.id)[0]!.id).kind).toBe('held');
    expect(f.requests).toHaveLength(3);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
