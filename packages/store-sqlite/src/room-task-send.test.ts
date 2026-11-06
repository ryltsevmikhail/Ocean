import { expect, it } from 'vitest';
import { roomTasks, attachRoomActor } from '../test-fixtures/room-tasks.js';
it('publishes a peer message from a real claimed delivery and settled persisted Core attempt', async () => {
  const f = roomTasks();
  try {
    const start = f.service.start(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value);
    expect(
      f.store.conversations.atomic((tx) =>
        tx.roomTasks!.origin(actor.turnId, actor.taskRunId, actor.attemptId, true),
      ),
    ).not.toBeNull();
    const sent = f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'hello B' });
    expect(sent.ok).toBe(true);
    expect(f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'hello B' })).toEqual(sent);
    expect(f.store.conversations.atomic((tx) => tx.history('room', 0, 10))).toMatchObject([
      { author: 'user' },
      { author: 'bot', authorBotId: 'a', targetBotId: 'b', turnId: actor.turnId, body: 'hello B' },
    ]);
  } finally {
    f.close();
  }
});
it('retains A attribution for two peer publications then permits exactly one ordinary final reply', async () => {
  const f = roomTasks();
  try {
    const start = f.service.start(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value);
    for (const callId of [actor.callId, actor.callId + '2'])
      expect(
        f.service.send({ ...actor, callId }, { kind: 'message', toBotId: 'b', text: 'peer' }).ok,
      ).toBe(true);
    const final = {
      id: 'reply_' + actor.turnId,
      workspaceId: f.input.workspaceId,
      roomId: 'room',
      seq: 4,
      author: 'bot' as const,
      authorBotId: 'a',
      targetBotId: 'a',
      turnId: actor.turnId,
      body: 'final',
      createdAt: '2026-11-06T00:00:00Z',
    };
    f.store.conversations.atomic((tx) => tx.putMessage(final));
    expect(() =>
      f.store.conversations.atomic((tx) => tx.putMessage({ ...final, id: 'second-final', seq: 5 })),
    ).toThrow();
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.putMessage({ ...final, id: 'unbacked', seq: 5, targetBotId: 'b' }),
      ),
    ).toThrow('addressed message requires delivery');
    expect(
      f.store.conversations
        .atomic((tx) => tx.history('room', 0, 10))
        .map((m) => [m.authorBotId, m.targetBotId]),
    ).toEqual([
      [undefined, null],
      ['a', 'b'],
      ['a', 'b'],
      ['a', 'a'],
    ]);
    expect(f.db!.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    f.close();
  }
});
it('rejects extra hidden/symbol model fields and self-targets before writing', async () => {
  const f = roomTasks();
  try {
    const start = f.service.start(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      request = { kind: 'message', toBotId: 'b', text: 'hello' };
    for (const extra of ['attachment', Symbol('attachment')]) {
      const bad = { ...request };
      Object.defineProperty(bad, extra, { value: 'binary', enumerable: false });
      expect(f.service.send(actor, bad)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    expect(f.service.send(actor, { ...request, toBotId: 'a' }).ok).toBe(false);
    expect(f.store.conversations.atomic((tx) => tx.history('room', 0, 10))).toHaveLength(1);
  } finally {
    f.close();
  }
});
