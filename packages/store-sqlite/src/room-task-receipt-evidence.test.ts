import { expect, it } from 'vitest';
import { canonicalJson } from '@runnets/domain';
import { hostedRoomTasks, attachRoomActor } from '../test-fixtures/room-tasks.js';
const contents = (f: ReturnType<typeof hostedRoomTasks>) =>
  ['ocean_room_tasks', 'ocean_room_deliveries', 'ocean_messages', 'ocean_receipts'].map((table) =>
    f.db!.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
it.each(['start', 'send'] as const)(
  'refuses complete-key mixed message/root evidence on %s replay',
  async (mode) => {
    const f = hostedRoomTasks();
    try {
      const start = f.service.startHosted(f.input);
      if (!start.ok) throw Error('start');
      const actor = mode === 'send' ? await attachRoomActor(f, start.value) : null;
      const request = { kind: 'message', toBotId: 'b', text: 'peer' };
      const admitted = actor ? f.service.send(actor, request) : start;
      if (!admitted.ok) throw Error('admit');
      const retry = () => (actor ? f.service.send(actor, request) : f.service.startHosted(f.input));
      expect(retry()).toEqual(admitted);
      const key = String(
        f
          .db!.prepare('SELECT request_key FROM ocean_room_deliveries WHERE message_id=?')
          .get(admitted.value.messageId)?.['request_key'],
      );
      const other = f.service.startHosted({ ...f.input, requestId: 'other', initialBotIds: ['c'] });
      if (!other.ok) throw Error('other');
      f.store.conversations.atomic((tx) => {
        const rt = tx.roomTasks!,
          child = rt.task(other.value.deliveries[0]!.taskId)!;
        if (child.kind !== 'bot') throw Error('child');
        rt.putTask({ ...child, id: 'extra-task' });
        const delivery = rt.deliveriesForReceipt('other', other.value.messageId)[0]!;
        rt.putDelivery({
          ...delivery,
          id: 'extra-delivery',
          toTaskId: 'extra-task',
          requestKey: key,
          position: 31,
        });
      });
      expect(f.db!.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        f
          .db!.prepare(
            'SELECT count(DISTINCT message_id) AS n FROM ocean_room_deliveries WHERE request_key=?',
          )
          .get(key)?.['n'],
      ).toBe(2);
      const before = contents(f);
      expect(retry()).toMatchObject({ ok: false, error: { code: 'request_conflict' } });
      expect(contents(f)).toEqual(before);
    } finally {
      f.close();
    }
  },
);
it.each(['text', 'room', 'workspace'] as const)(
  'ties owner receipt replay to the bound %s facts',
  (field) => {
    const f = hostedRoomTasks();
    try {
      const admitted = f.service.startHosted(f.input);
      expect(admitted.ok).toBe(true);
      expect(f.service.startHosted(f.input)).toEqual(admitted);
      f.store.conversations.atomic((tx) =>
        tx.putRoom({
          id: 'other-room',
          workspaceId: f.input.workspaceId,
          kind: 'group',
          title: 'Other',
          botIds: ['a', 'b', 'c'],
        }),
      );
      const input = {
        ...f.input,
        ...(field === 'text'
          ? { text: 'other' }
          : field === 'room'
            ? { roomId: 'other-room' }
            : { workspaceId: 'other-workspace' }),
      };
      const binding = canonicalJson([
        'RoomTaskStart/v1',
        'owner',
        input.workspaceId,
        input.roomId,
        input.text,
        input.initialBotIds,
        input.participants,
        input.mandate,
      ]);
      f.db!.prepare('UPDATE ocean_receipts SET binding=? WHERE request_id=?').run(
        binding,
        input.requestId,
      );
      const before = contents(f);
      expect(f.service.startHosted(input)).toMatchObject({
        ok: false,
        error: { code: 'request_conflict' },
      });
      expect(contents(f)).toEqual(before);
    } finally {
      f.close();
    }
  },
);
it('ties peer replay body to the bound request even when receipt and history agree', async () => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      request = { kind: 'message', toBotId: 'b', text: 'original' };
    const sent = f.service.send(actor, request);
    if (!sent.ok) throw Error('send');
    expect(f.service.send(actor, request)).toEqual(sent);
    const row = f
      .db!.prepare('SELECT * FROM ocean_room_deliveries WHERE message_id=?')
      .get(sent.value.messageId)!;
    const binding = canonicalJson([
      f.input.workspaceId,
      'room',
      start.value.rootId,
      row['from_task_id'],
      row['cause_id'],
      'a',
      'message',
      'b',
      'other',
    ]);
    f.db!.prepare('UPDATE ocean_receipts SET binding=? WHERE request_id=?').run(
      binding,
      String(row['request_key']),
    );
    const before = contents(f);
    expect(f.service.send(actor, { ...request, text: 'other' })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    expect(contents(f)).toEqual(before);
  } finally {
    f.close();
  }
});
it('refuses an owner target inconsistent with its room even in matching corrupted receipt/history', () => {
  const f = hostedRoomTasks();
  try {
    const admitted = f.service.startHosted(f.input);
    if (!admitted.ok) throw Error('start');
    // Simulate corrupt archived bytes; production identity updates must remain prohibited.
    f.db!.exec('DROP TRIGGER IF EXISTS ocean_message_immutable');
    f.db!.prepare("UPDATE ocean_messages SET target_bot_id='a' WHERE id=?").run(
      admitted.value.messageId,
    );
    f.db!.prepare(
      "UPDATE ocean_receipts SET reply=json_set(reply,'$.data.targetBotId','a') WHERE request_id=?",
    ).run(f.input.requestId);
    const before = contents(f);
    expect(f.service.startHosted(f.input)).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    expect(contents(f)).toEqual(before);
  } finally {
    f.close();
  }
});
