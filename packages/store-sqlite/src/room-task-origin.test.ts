import { expect, it } from 'vitest';
import { hostedRoomTasks, attachRoomActor, roomTaskCounts } from '../test-fixtures/room-tasks.js';
it('refuses forged actor, wrong run/attempt/ordinal and unknown or absent settlement with zero writes', async () => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      request = { kind: 'message', toBotId: 'b', text: 'text' };
    const before = roomTaskCounts(f);
    for (const changed of [
      { ...actor, turnId: 'forged' },
      { ...actor, taskRunId: 'tr_other' },
      { ...actor, attemptId: 'at_other' },
      { ...actor, callId: actor.callId.replace('_r1_', '_r2_') },
    ])
      expect(f.service.send(changed, request).ok).toBe(false);
    // Use actual terminal settlement payload irrespective of its event name.
    const last = f
      .db!.prepare(
        "SELECT * FROM events WHERE aggregate_id=? AND type='attempt.model_request_settled'",
      )
      .get(actor.taskRunId)!;
    const payload = JSON.parse(String(last['payload'])) as Record<string, unknown>;
    f.db!.prepare('UPDATE events SET payload=? WHERE aggregate_id=? AND sequence=?').run(
      JSON.stringify({ ...payload, completion: { kind: 'unknown' } }),
      actor.taskRunId,
      last['sequence'] as number,
    );
    expect(f.service.send(actor, request).ok).toBe(false);
    f.db!.prepare('DELETE FROM events WHERE aggregate_id=? AND sequence=?').run(
      actor.taskRunId,
      last['sequence'] as number,
    );
    expect(f.service.send(actor, request).ok).toBe(false);
    expect(roomTaskCounts(f)).toEqual({ ...before, events: before['events']! - 1 });
  } finally {
    f.close();
  }
});
it.each(['a', 'b'] as const)(
  'checks current %s recipient scope while retaining settled sender identity',
  async (changed) => {
    const f = hostedRoomTasks();
    try {
      const start = f.service.startHosted(f.input);
      if (!start.ok) throw Error('start');
      const actor = await attachRoomActor(f, start.value);
      expect(f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'before edit' }).ok).toBe(
        true,
      );
      f.store.conversations.atomic((tx) =>
        tx.replaceBot({ ...tx.bot(changed)!, model: 'changed', profileVersion: 2 }, 1),
      );
      const before = roomTaskCounts(f);
      const sent = f.service.send(
        { ...actor, callId: actor.callId + '2' },
        { kind: 'message', toBotId: 'b', text: 'after edit' },
      );
      if (changed === 'a') expect(sent.ok).toBe(true);
      else {
        expect(sent).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } });
        expect(roomTaskCounts(f)).toEqual(before);
      }
      const root = f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.value.rootId));
      expect(root?.rootPayload?.members.map((m) => m.identity.modelId)).toEqual([
        'one',
        'one',
        'one',
      ]);
    } finally {
      f.close();
    }
  },
);

it('rejects stopped sources, removed recipients and invalid marker mutations', async () => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value),
      request = { kind: 'message', toBotId: 'c', text: 'hello' };
    f.db!.exec("DELETE FROM ocean_members WHERE room_id='room' AND bot_id='c'");
    expect(f.service.send(actor, request)).toMatchObject({
      ok: false,
      error: { code: 'not_member' },
    });
    f.db!.prepare("UPDATE ocean_room_tasks SET status='stopped' WHERE id=?").run(
      start.value.rootId,
    );
    expect(f.service.send(actor, { ...request, toBotId: 'b' }).ok).toBe(false);
    expect(() =>
      f
        .db!.prepare(
          "UPDATE ocean_chat_turns SET payload=json_set(payload,'$.roomDelivery.taskId','forged') WHERE id=?",
        )
        .run(actor.turnId),
    ).toThrow('immutable room turn');
    const turn = f.store.conversations.atomic((tx) => tx.chatTurn(actor.turnId))!;
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.putChatTurn({ ...turn, id: 'other', taskRunId: 'tr_other' }),
      ),
    ).toThrow();
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.putChatTurn({
          ...turn,
          activation: {
            ...turn.activation!,
            identity: { source: 'host', providerId: 'forged', modelId: 'one' },
          },
        }),
      ),
    ).toThrow('immutable room turn');
  } finally {
    f.close();
  }
});
it('rejects a marked actor whose persisted bot profile disagrees with its activation pin', async () => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value, 'a', 2);
    expect(
      f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'forged profile' }).ok,
    ).toBe(false);
  } finally {
    f.close();
  }
});
it('derives coding subjects from the actual owning task and requires reserved dev-scoped refs', async () => {
  const { ownerGrant } = await import('../../../test-fixtures/service-authority.js');
  const { sha256 } = await import('../test-fixtures/room-tasks.js');
  const f = hostedRoomTasks();
  try {
    f.store.coding.atomic((tx) =>
      tx.putTask({
        id: 'coding',
        workspaceId: f.input.workspaceId,
        projectRoot: '/actual-project',
        baseCommit: 'a'.repeat(40),
        worktreeRoot: null,
        ownerRoomId: 'room',
        devBotId: 'a',
        reviewBotId: 'b',
        reviewRoomId: 'room',
        status: 'reserved',
        policyVersion: 1,
        policy: {
          version: 1,
          devCapabilities: [],
          reviewCapabilities: ['changeset_read'],
          testPresets: [],
        },
        lease: {
          projectRoot: '/actual-project',
          token: 'fixture',
          ownerId: 'owner',
          taskId: 'coding',
          requestId: 'coding',
          binding: 'fixture',
          kind: 'coding',
        },
        createdAt: '2026-11-06T00:00:00Z',
      }),
    );
    f.store.serviceAuthority.atomic((tx) =>
      tx.putGrant(
        {
          ...ownerGrant,
          id: 'dev-grant',
          subject: {
            workspaceId: f.input.workspaceId,
            roomId: 'room',
            botId: 'a',
            projectId: sha256('/actual-project'),
            taskId: 'coding',
          },
        },
        null,
      ),
    );
    const input = {
      ...f.input,
      mandate: { ...f.input.mandate, codingTaskId: 'coding' },
      participants: f.input.participants.map((p) =>
        p.botId === 'a' ? { ...p, grantReferences: [{ grantId: 'dev-grant', revision: 1 }] } : p,
      ),
    };
    expect(
      f.service.startHosted({
        ...input,
        mandate: { ...input.mandate, projectId: sha256('/fixture') },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.service.startHosted(input).ok).toBe(true);
    f.store.coding.atomic((tx) => {
      const task = tx.task('coding')!;
      tx.putTask({ ...task, status: 'cancelled' });
    });
    expect(f.service.startHosted({ ...input, requestId: 'cancelled-coding' })).toMatchObject({
      ok: false,
      error: { code: 'approval_required' },
    });
  } finally {
    f.close();
  }
});
it('refuses legacy turns and preserves old uncertainty admission semantics', async () => {
  const f = hostedRoomTasks();
  try {
    const started = f.service.startHosted(f.input);
    if (!started.ok) throw Error('start');
    const actor = await attachRoomActor(f, started.value);
    const marked = f.store.conversations.atomic((tx) => tx.chatTurn(actor.turnId))!;
    const { roomDelivery: _marker, ...turn } = marked;
    f.store.conversations.atomic((tx) =>
      tx.putChatTurn({ ...turn, id: 'legacy', taskRunId: 'tr_legacy', status: 'uncertain' }),
    );
    expect(
      f.service.send(
        { ...actor, turnId: 'legacy', taskRunId: 'tr_legacy' },
        { kind: 'message', toBotId: 'b', text: 'legacy' },
      ).ok,
    ).toBe(false);
    expect(f.service.startHosted({ ...f.input, requestId: 'after-uncertainty' })).toMatchObject({
      ok: false,
      error: { code: 'recovery_required' },
    });
    f.store.conversations.atomic((tx) =>
      tx.putChatTurn({ ...turn, id: 'legacy', taskRunId: 'tr_legacy', status: 'accepted' }),
    );
    expect(f.service.startHosted({ ...f.input, requestId: 'after-accepted' })).toMatchObject({
      ok: false,
      error: { code: 'room_busy' },
    });
    const counts = roomTaskCounts(f);
    expect(counts['ocean_room_tasks']).toBe(3);
  } finally {
    f.close();
  }
});
it('treats a missing queued recipient pin as unknown transfer evidence', () => {
  const f = hostedRoomTasks();
  try {
    const start = f.service.startHosted(f.input);
    if (!start.ok) throw Error('start');
    f.db!.exec('DROP TRIGGER ocean_room_task_immutable');
    f.db!.prepare(
      "UPDATE ocean_room_tasks SET root_payload=json_set(root_payload,'$.members',json('[]')) WHERE id=?",
    ).run(start.value.rootId);
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.pendingTransfer('room'))).toBe(true);
  } finally {
    f.close();
  }
});
