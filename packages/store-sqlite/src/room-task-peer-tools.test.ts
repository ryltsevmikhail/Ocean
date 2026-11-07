import { expect, it } from 'vitest';
import {
  createChatCommand,
  recoverUnstartedRoomClaims,
  roomTaskState,
  type RoomTaskStart,
} from '@runnets/application';
import { attachRoomActor, hostedRoomTasks, roomTaskCounts } from '../test-fixtures/room-tasks.js';
import { roomSlices } from '../test-fixtures/room-slices.js';

function restricted(input: RoomTaskStart): RoomTaskStart {
  return {
    ...input,
    initialBotIds: ['a'],
    participants: input.participants.map((p) => (p.botId === 'a' ? { ...p, peerTools: false } : p)),
  };
}

it('recovers an unstarted claim with the same turn and no peer tools', async () => {
  const f = roomSlices([], []);
  try {
    const start = f.service.startHosted(restricted(f.input));
    if (!start.ok) throw Error(start.error.code);
    const claim = f.claim(start.value.deliveries[0]!.deliveryId);
    if (claim.kind !== 'claimed') throw Error('claim');
    const created = await f.tasks.execute(createChatCommand(claim.turn, claim.parentRunId));
    expect(created.ok).toBe(true);
    expect(recoverUnstartedRoomClaims(f.deps)).toMatchObject([
      {
        turn: {
          id: claim.turn.id,
          taskRunId: claim.turn.taskRunId,
          activation: { capabilities: { tools: true } },
        },
        tools: null,
      },
    ]);
    expect(f.requests).toHaveLength(0);
  } finally {
    f.close();
  }
});

it.each([false, undefined] as const)(
  'checks fresh room operations at the transaction boundary (peerTools: %s)',
  async (peerTools) => {
    const f = hostedRoomTasks();
    try {
      const start = f.service.startHosted(peerTools === false ? restricted(f.input) : f.input);
      if (!start.ok) throw Error(start.error.code);
      const actor = await attachRoomActor(f, start.value);
      const target = start.value.deliveries[0]!.taskId;
      const state = () => roomTaskState(f.service.deps, actor, target);
      const before = roomTaskCounts(f);
      if (peerTools === false) expect.soft(state).toThrow('authority_denied');
      else {
        const saved = state();
        expect(saved).toMatchObject({ fresh: true, reply: { taskId: target } });
        expect(state()).toMatchObject({ ...saved, fresh: false });
      }
      for (const [index, kind] of ['message', 'delegate'].entries()) {
        const attempt = { ...actor, callId: `${actor.callId}_${index}` };
        const request = { kind, toBotId: 'c', text: 'ask C' };
        const sent = f.service.send(attempt, request);
        if (peerTools === false) {
          expect.soft(sent).toMatchObject({ ok: false, error: { code: 'approval_required' } });
        } else {
          expect(sent).toMatchObject({ ok: true });
          expect(f.service.send(attempt, request)).toEqual(sent);
        }
      }
      if (peerTools === false) expect(roomTaskCounts(f)).toEqual(before);
    } finally {
      f.close();
    }
  },
);
