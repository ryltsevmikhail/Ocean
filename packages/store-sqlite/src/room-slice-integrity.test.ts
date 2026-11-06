import { taskRunId } from '@runnets/domain';
import { expect, it } from 'vitest';
import { roomTasks, attachRoomActor } from '../test-fixtures/room-tasks.js';
it('protects the entire admitted room activation on actual upsert', async () => {
  const f = roomTasks();
  try {
    const started = f.service.start(f.input);
    if (!started.ok) throw Error('start');
    const actor = await attachRoomActor(f, started.value);
    const turn = f.store.conversations.atomic((tx) => tx.chatTurn(actor.turnId))!;
    expect(() => f.store.conversations.atomic((tx) => tx.putChatTurn(turn))).not.toThrow();
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.putChatTurn({
          ...turn,
          activation: { ...turn.activation!, deadlineAt: '2027-01-01T00:00:00Z' },
        }),
      ),
    ).toThrow();
  } finally {
    f.close();
  }
});

it.each(['proofVersion', 'proofCall', 'markerKeys', 'disposition', 'foreignProof'] as const)(
  'rejects raw malformed %s before persistence',
  async (mode) => {
    const { roomSlices, delegate } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([delegate('b', 'go')]);
    try {
      const start = f.start(),
        turn = await f.execute(start.deliveries[0]!.deliveryId);
      const payload: Record<string, unknown> = { ...structuredClone(turn) };
      if (mode === 'proofVersion')
        payload['roomHandoff'] = { ...turn.roomHandoff, expectedRunVersion: 0 };
      if (mode === 'proofCall') payload['roomHandoff'] = { ...turn.roomHandoff, callId: '' };
      if (mode === 'markerKeys')
        payload['roomDelivery'] = { ...turn.roomDelivery, extra: 'authority' };
      if (mode === 'disposition') payload['roomSliceDisposition'] = 'final';
      if (mode === 'foreignProof')
        payload['roomHandoff'] = { ...turn.roomHandoff, taskRunId: 'other' };
      expect(() =>
        f
          .db!.prepare('UPDATE ocean_chat_turns SET payload=? WHERE id=?')
          .run(JSON.stringify(payload), turn.id),
      ).toThrow();
    } finally {
      f.close();
    }
  },
);

it.each(['markerKeys', 'markerNull', 'proofWithoutMarker'] as const)(
  'rejects malformed %s on actual INSERT rather than relying on a decoder',
  async (mode) => {
    const { roomSlices } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([]);
    try {
      const start = f.start(),
        c = f.claim(start.deliveries[0]!.deliveryId);
      if (c.kind !== 'claimed') throw Error('claim');
      const payload: Record<string, unknown> = { ...c.turn };
      if (mode === 'markerKeys')
        payload['roomDelivery'] = { ...c.turn.roomDelivery, extra: 'authority' };
      if (mode === 'markerNull') payload['roomDelivery'] = null;
      if (mode === 'proofWithoutMarker') {
        delete payload['roomDelivery'];
        payload['roomSliceDisposition'] = 'yielded';
      }
      f.db!.prepare('DELETE FROM ocean_chat_turns WHERE id=?').run(c.turn.id);
      expect(() =>
        f
          .db!.prepare('INSERT INTO ocean_chat_turns VALUES(?,?,?,?,?,?,?)')
          .run(
            c.turn.id,
            c.turn.workspaceId,
            c.turn.roomId,
            c.turn.taskRunId,
            c.turn.status,
            JSON.stringify(payload),
            null,
          ),
      ).toThrow();
    } finally {
      f.close();
    }
  },
);

it.each(['member', 'pin', 'policy', 'stop', 'receipt', 'unknown', 'physical'] as const)(
  'keeps queued work inert after altered %s evidence',
  async (mode) => {
    const { roomSlices } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([]);
    try {
      const input =
        mode === 'physical'
          ? {
              ...f.input,
              mandate: {
                ...f.input.mandate,
                codingTaskId: null,
                permissions: [
                  {
                    kind: 'coding' as const,
                    actions: ['project_read' as const],
                    resources: [
                      { kind: 'project-worktree' as const, projectId: 'project', worktreeId: null },
                    ],
                  },
                ],
              },
            }
          : f.input;
      const start = f.service.start({ ...input, initialBotIds: ['a'] });
      if (!start.ok) throw Error('start');
      if (mode === 'member')
        f.db!.prepare("DELETE FROM ocean_members WHERE room_id='room' AND bot_id='a'").run();
      if (mode === 'pin')
        f.store.conversations.atomic((tx) =>
          tx.replaceBot({ ...tx.bot('a')!, profileVersion: 2 }, 1),
        );
      if (mode === 'policy')
        f.store.conversations.atomic((tx) =>
          tx.putRoomModelPolicy({ roomId: 'room', cloudTransfer: 'deny', revision: 2 }),
        );
      if (mode === 'stop')
        f.store.conversations.atomic((tx) => {
          const root = tx.roomTasks!.task(start.value.rootId)!;
          tx.roomTasks!.advanceTask({ ...root, status: 'stopped' }, root.revision);
        });
      if (mode === 'receipt')
        f.db!.prepare("UPDATE ocean_receipts SET binding='altered' WHERE request_id='start'").run();
      if (mode === 'unknown')
        f.db!.exec("INSERT INTO tool_invocations_v1 VALUES('unknown','legacy','uncertain')");
      expect(f.claim(start.value.deliveries[0]!.deliveryId).kind).toBe('held');
      expect(f.turns()).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    } finally {
      f.close();
    }
  },
);

it.each(['cause', 'attempt', 'sender', 'final', 'parent'] as const)(
  'rejects forged inverse %s even with a real B final and waiting parent',
  async (mode) => {
    const { roomSlices, delegate, answer } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([delegate('b', 'go'), answer('B done')]);
    try {
      const start = f.start(),
        a = await f.execute(start.deliveries[0]!.deliveryId);
      await f.execute(a.roomHandoff!.deliveryId);
      const result = f.deliveries(a.roomDelivery!.taskId).find((r) => r.kind === 'result')!;
      f.db!.prepare('DELETE FROM ocean_room_deliveries WHERE id=?').run(result.id);
      f.store.conversations.atomic((tx) => {
        const parent = tx.roomTasks!.task(a.roomDelivery!.taskId)!;
        if (parent.kind !== 'bot') throw Error('parent');
        tx.roomTasks!.advanceTask(
          { ...parent, status: 'waiting', waitingChildId: a.roomHandoff!.childTaskId },
          parent.revision,
        );
      });
      const changed = {
        ...result,
        ...(mode === 'cause' ? { causeId: a.roomDelivery!.deliveryId } : {}),
        ...(mode === 'attempt' ? { sourceAttemptId: 'wrong' } : {}),
        ...(mode === 'sender' ? { senderBotId: 'a' } : {}),
        ...(mode === 'final' ? { messageId: a.inboundMessageId, seq: a.readThroughSeq } : {}),
        ...(mode === 'parent' ? { toTaskId: result.fromTaskId! } : {}),
      };
      expect(() =>
        f.store.conversations.atomic((tx) => tx.roomTasks!.putDelivery(changed)),
      ).toThrow('invalid room delivery lineage');
    } finally {
      f.close();
    }
  },
);

it.each(['head', 'receipt', 'stop', 'pin', 'unknown', 'unrelated'] as const)(
  'repairs only proven affected work after %s changes',
  async (mode) => {
    const { roomSlices, delegate } = await import('../test-fixtures/room-slices.js');
    const { repairRoomHandoff, executeStep } = await import('@runnets/application');
    const f = roomSlices([delegate('b', 'go')]);
    try {
      const start = f.start(),
        execute = f.tasks.executeWithDisposition.bind(f.tasks);
      f.tasks.executeWithDisposition = async (c) => {
        if (c.type === 'Complete') throw Error('power loss');
        return execute(c);
      };
      const turn = await f.execute(start.deliveries[0]!.deliveryId);
      f.tasks.executeWithDisposition = execute;
      if (mode === 'head') {
        const state = await f.tasks.state(taskRunId(turn.taskRunId));
        expect(
          (
            await executeStep(
              f.tasks,
              taskRunId(turn.taskRunId),
              'BeginReconcile',
              { reason: 'reconciliation' },
              state.version,
            )
          ).ok,
        ).toBe(true);
      }
      if (mode === 'receipt')
        f.db!.prepare(
          "UPDATE ocean_receipts SET binding='changed' WHERE request_id IN (SELECT request_key FROM ocean_room_deliveries WHERE id=?)",
        ).run(turn.roomHandoff!.deliveryId);
      if (mode === 'stop')
        f.store.conversations.atomic((tx) => {
          const root = tx.roomTasks!.task(start.rootId)!;
          tx.roomTasks!.advanceTask({ ...root, status: 'stopped' }, root.revision);
        });
      if (mode === 'pin')
        f.store.conversations.atomic((tx) =>
          tx.replaceBot({ ...tx.bot('a')!, profileVersion: 2 }, 1),
        );
      if (mode === 'unknown')
        f.db!.exec("INSERT INTO tool_invocations_v1 VALUES('unknown','legacy','uncertain')");
      if (mode === 'unrelated')
        await f.store.tools.claim(
          'unrelated',
          'read',
          { taskRunId: 'other', attemptId: 'other' },
          'other',
        );
      const repaired = await repairRoomHandoff(f.deps, turn.id);
      expect(repaired?.roomSliceDisposition ?? null).toBe(mode === 'unrelated' ? 'yielded' : null);
      expect(f.requests).toHaveLength(1);
      expect(f.claim(turn.roomHandoff!.deliveryId).kind).toBe(
        mode === 'unrelated' ? 'claimed' : 'held',
      );
    } finally {
      f.close();
    }
  },
);

it.each([false, true])(
  'rechecks selected room grant references at claim, revoked=%s',
  async (revoked) => {
    const { ownerGrant } = await import('../../../test-fixtures/service-authority.js');
    const { roomSlices } = await import('../test-fixtures/room-slices.js');
    const f = roomSlices([]);
    try {
      f.store.serviceAuthority.atomic((tx) =>
        tx.putGrant(
          {
            ...ownerGrant,
            subject: {
              ...ownerGrant.subject,
              workspaceId: f.input.workspaceId,
              roomId: 'room',
              botId: 'a',
              projectId: f.deps.sha256('/fixture'),
            },
          },
          null,
        ),
      );
      const start = f.service.start({
        ...f.input,
        initialBotIds: ['a'],
        participants: f.input.participants.map((p) =>
          p.botId === 'a'
            ? { ...p, grantReferences: [{ grantId: ownerGrant.id, revision: 1 }] }
            : p,
        ),
      });
      if (!start.ok) throw Error('grant start');
      if (revoked)
        f.store.serviceAuthority.atomic((tx) =>
          tx.putGrant({ ...tx.grant(ownerGrant.id)!, revision: 2, state: 'revoked' }, 1),
        );
      expect(f.claim(start.value.deliveries[0]!.deliveryId).kind).toBe(
        revoked ? 'held' : 'claimed',
      );
    } finally {
      f.close();
    }
  },
);
