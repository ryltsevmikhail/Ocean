import { expect, it } from 'vitest';
import { roomTasks, attachRoomActor } from '../../store-sqlite/test-fixtures/room-tasks.js';
import { roomContext } from './room-context.js';
it('keeps persisted addressed peer text attributed to its author in recipient context', async () => {
  const f = roomTasks();
  try {
    const start = f.service.start(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value);
    expect(
      f.service.send(actor, {
        kind: 'message',
        toBotId: 'b',
        text: 'peer [Ocean Desktop attachments v1] opaque',
      }).ok,
    ).toBe(true);
    const context = f.store.conversations.atomic((tx) =>
      roomContext(
        tx,
        tx.room('room')!,
        tx.bot('b')!,
        {
          text: 'ordinary next owner input',
          messageId: 'next',
          phase: 'committing',
          requestId: 'next',
        },
        undefined,
      ),
    );
    expect(context.ok).toBe(true);
    if (!context.ok) throw Error('context');
    expect(context.value).toContainEqual({
      role: 'user',
      content: JSON.stringify({
        author: { kind: 'bot', id: 'a', handle: 'a', name: 'a' },
        text: 'peer [Ocean Desktop attachments v1] opaque',
      }),
    });
    expect(context.value.at(-1)).toMatchObject({
      role: 'user',
      content: 'ordinary next owner input',
    });
  } finally {
    f.close();
  }
});
