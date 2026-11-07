import { taskRunId } from '@runnets/domain';
import { DirectChatService } from '@runnets/application';
import { attachRoomActor } from '../test-fixtures/room-tasks.js';
import { expect, it } from 'vitest';
import { roomSlices, answer, delegate } from '../test-fixtures/room-slices.js';
it('runs A delegate, text-only B final, then fresh A on the same task with one inverse result', async () => {
  const f = roomSlices([delegate('b', 'ask B'), answer('B done'), answer('A done')]);
  try {
    const start = f.start(),
      initial = start.deliveries[0]!;
    const a1 = await f.execute(initial.deliveryId);
    expect(a1).toMatchObject({
      status: 'completed',
      roomSliceDisposition: 'yielded',
      text: '',
      preparedVersion: null,
    });
    const query = { workspaceId: a1.workspaceId, roomId: a1.roomId, runId: a1.taskRunId };
    expect((await new DirectChatService(f.deps).getRun(query))?.resultMessageId).toBeNull();
    expect(
      f.store.openRoomReads(() => f.deps.clock.now().getTime()).run(query)?.resultMessageId,
    ).toBeNull();
    expect(f.store.openRoomReads(() => f.deps.clock.now().getTime()).result(query)).toBeNull();
    const child = f.store.conversations
      .atomic((tx) => tx.roomTasks!.tasks(start.rootId))
      .find((t) => t.assigneeBotId === 'b')!;
    const b1 = await f.execute(f.deliveries(child.id)[0]!.id);
    expect(b1).toMatchObject({ status: 'completed', text: 'B done' });
    const result = f.deliveries(initial.taskId).find((d) => d.kind === 'result')!;
    expect(result.messageId).toBe('reply_' + b1.id);
    f.advance(600001);
    const a2 = await f.execute(result.id);
    expect(a2.roomDelivery?.taskId).toBe(initial.taskId);
    expect(a2.activation!.admittedAt > a1.activation!.deadlineAt).toBe(true);
    expect(a2).toMatchObject({ status: 'completed', text: 'A done' });
    expect(f.turns()).toHaveLength(3);
    expect(f.requests).toHaveLength(3);
    expect(f.requests[1]!.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(f.requests[2]!.messages).match(/B done/g)).toHaveLength(1);
    expect(JSON.stringify(f.requests[2]!.messages)).toContain('author');
    const states = await Promise.all(f.turns().map((t) => f.tasks.state(taskRunId(t.taskRunId))));
    expect(states.map((s) => (s.status === 'absent' ? null : s.parentTaskRunId))).toEqual([
      null,
      a1.taskRunId,
      a1.taskRunId,
    ]);
    expect(
      f.db!.prepare('SELECT id FROM ocean_messages WHERE id=?').get('reply_' + a1.id),
    ).toBeUndefined();
    expect(
      f.db!.prepare("SELECT count(*) AS n FROM ocean_room_deliveries WHERE kind='result'").get()?.[
        'n'
      ],
    ).toBe(1);
    expect(f.db!.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.rootId)?.status)).toBe(
      'completed',
    );
  } finally {
    f.close();
  }
});

it('drains an earlier queued input exactly and emits only one terminal assignment result', async () => {
  const f = roomSlices(
    [
      delegate('b', 'first B'),
      delegate('c', 'C work'),
      answer('C done'),
      answer('B first'),
      answer('B terminal'),
      answer('A final'),
    ],
    ['c'],
  );
  try {
    const start = f.start(),
      a = await f.execute(start.deliveries[0]!.deliveryId);
    const outbound = f.store.conversations.atomic((tx) =>
      tx.roomTasks!.delivery(a.roomHandoff!.deliveryId),
    )!;
    const b = await f.execute(outbound.id);
    f.store.conversations.atomic((tx) => {
      const message = {
        id: 'extra_message',
        workspaceId: a.workspaceId,
        roomId: a.roomId,
        seq: tx.nextSequence(a.roomId),
        author: 'bot' as const,
        authorBotId: 'a',
        targetBotId: 'b',
        turnId: a.id,
        body: 'additional B input',
        createdAt: f.deps.clock.now().toISOString(),
      };
      tx.roomTasks!.putDelivery({
        ...outbound,
        id: 'extra_delivery',
        kind: 'message',
        messageId: message.id,
        seq: message.seq,
        requestKey: 'extra_receipt',
        state: 'queued',
      });
      tx.putMessage(message);
      tx.putReceipt('extra_receipt', {
        binding: JSON.stringify([
          a.workspaceId,
          a.roomId,
          start.rootId,
          a.roomDelivery!.taskId,
          a.roomDelivery!.deliveryId,
          'a',
          'message',
          'b',
          message.body,
        ]),
        reply: { kind: 'message', data: message },
      });
    });
    await f.execute(b.roomHandoff!.deliveryId);
    const childResult = f.deliveries(b.roomDelivery!.taskId).find((v) => v.kind === 'result')!;
    expect(f.claim('extra_delivery').kind).toBe('held');
    await f.execute(childResult.id);
    expect(f.deliveries(a.roomDelivery!.taskId).filter((d) => d.kind === 'result')).toHaveLength(0);
    expect(f.deliveries(outbound.toTaskId).find((d) => d.id === 'extra_delivery')?.state).toBe(
      'queued',
    );
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.task(outbound.toTaskId)?.status),
    ).toBe('ready');
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.task(a.roomDelivery!.taskId)?.status),
    ).toBe('waiting');
    const terminal = await f.execute('extra_delivery');
    expect(terminal.readThroughSeq).toBe(4);
    expect(JSON.stringify(f.requests[4]!.messages)).not.toContain('B first');
    const result = f.deliveries(a.roomDelivery!.taskId).find((d) => d.kind === 'result')!;
    expect(result.messageId).toBe('reply_' + terminal.id);
    await f.execute(result.id);
    expect(
      f
        .db!.prepare(
          "SELECT count(*) AS n FROM ocean_room_deliveries WHERE kind='result' AND from_task_id=?",
        )
        .get(outbound.toTaskId)?.['n'],
    ).toBe(1);
  } finally {
    f.close();
  }
});

it('allows an independent marked assignment to progress while A waits and preserves root capacity', async () => {
  const f = roomSlices([delegate('b', 'B work'), answer('C independent')]);
  try {
    const started = f.service.startHosted({ ...f.input, initialBotIds: ['a', 'c'] });
    if (!started.ok) throw Error('start');
    const a = await f.execute(started.value.deliveries[0]!.deliveryId);
    expect(a.roomSliceDisposition).toBe('yielded');
    const c = await f.execute(started.value.deliveries[1]!.deliveryId);
    expect(c.text).toBe('C independent');
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.task(a.roomDelivery!.taskId)?.status),
    ).toBe('waiting');
  } finally {
    f.close();
  }
});
it('enforces two claimed slices under the same root lock', () => {
  const f = roomSlices([]);
  try {
    const started = f.service.startHosted({ ...f.input, initialBotIds: ['a', 'b', 'c'] });
    if (!started.ok) throw Error('start');
    expect(f.claim(started.value.deliveries[0]!.deliveryId).kind).toBe('claimed');
    expect(f.claim(started.value.deliveries[1]!.deliveryId).kind).toBe('claimed');
    expect(f.claim(started.value.deliveries[2]!.deliveryId).kind).toBe('held');
    expect(f.turns()).toHaveLength(2);
  } finally {
    f.close();
  }
});
it('never admits the thirty-third slice even with no currently executing run', async () => {
  const bots = ['a', 'b', 'c'];
  const f = roomSlices(
    Array.from({ length: 32 }, (_, i) => delegate(bots[(i + 1) % 3]!, 'bounded ' + i)),
    [],
  );
  try {
    const start = f.start();
    let delivery = start.deliveries[0]!.deliveryId;
    for (let i = 0; i < 32; i++) delivery = (await f.execute(delivery)).roomHandoff!.deliveryId;
    expect(f.claim(delivery).kind).toBe('held');
    expect(f.turns()).toHaveLength(32);
    expect(f.requests).toHaveLength(32);
  } finally {
    f.close();
  }
});

it('executes a committed message-only child without creating a result or waking its sender', async () => {
  const f = roomSlices([answer('message child final')]);
  try {
    const start = f.start(),
      actor = await attachRoomActor(f, start);
    const sent = f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'ordinary message' });
    if (!sent.ok) throw Error('message send');
    const child = await f.execute(sent.value.deliveries[0]!.deliveryId);
    expect(child.text).toBe('message child final');
    expect(
      f.deliveries(start.deliveries[0]!.taskId).filter((r) => r.kind === 'result'),
    ).toHaveLength(0);
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.deliveries[0]!.taskId)?.status),
    ).toBe('ready');
  } finally {
    f.close();
  }
});
