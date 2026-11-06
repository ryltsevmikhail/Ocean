import { expect, it } from 'vitest';
import { RoomBroadcastService } from '@runnets/application';
import { roomTasks, attachRoomActor, roomTaskCounts } from '../test-fixtures/room-tasks.js';
it('preserves legacy broadcast and uncertain room holds before new starts', () => {
  const f = roomTasks();
  try {
    const broadcast = new RoomBroadcastService({
      store: f.store.conversations,
      clock: f.service.deps.clock,
      nextId: (() => {
        let n = 0;
        return () => `legacy_${++n}`;
      })(),
    });
    expect(
      broadcast.submit({
        workspaceId: f.input.workspaceId,
        roomId: 'room',
        requestId: 'legacy',
        text: 'finite',
      }).ok,
    ).toBe(true);
    expect(f.service.start(f.input)).toMatchObject({ ok: false, error: { code: 'batch_open' } });
    expect(f.db!.prepare('SELECT count(*) AS n FROM ocean_room_tasks').get()?.['n']).toBe(0);
  } finally {
    f.close();
  }
});
it('fails closed on corrupt restore evidence while archived identical receipts stay readable', () => {
  const f = roomTasks();
  try {
    const old = f.service.start(f.input);
    expect(old.ok).toBe(true);
    f.db!.exec("INSERT INTO ocean_restore_origin VALUES(1,'{}')");
    const before = roomTaskCounts(f);
    expect(f.service.start(f.input)).toEqual(old);
    expect(() => f.service.start({ ...f.input, requestId: 'new' })).toThrow(
      'invalid_restore_origin',
    );
    expect(roomTaskCounts(f)).toEqual(before);
  } finally {
    f.close();
  }
});
it('keeps unaddressed notes and receipt-first legacy replay while fencing new direct execution', async () => {
  const { DirectChatService, TaskRunService } = await import('@runnets/application');
  const f = roomTasks();
  try {
    const tasks = new TaskRunService({
      log: f.store.log,
      clock: f.service.deps.clock,
      ids: { eventId: () => 'unused', commandId: () => 'unused' },
    });
    const chat = new DirectChatService({
      store: f.store.conversations,
      tasks,
      clock: f.service.deps.clock,
      nextId: () => 'note',
    });
    const request = {
      workspaceId: f.input.workspaceId,
      roomId: 'room',
      requestId: 'note',
      text: 'group note',
      provider: null,
      signal: new AbortController().signal,
      emit: () => {
        throw Error('no execution');
      },
    };
    expect(f.service.start(f.input).ok).toBe(true);
    expect(chat.submit({ ...request, to: 'a', requestId: 'direct' })).toMatchObject({
      ok: false,
      error: { code: 'room_busy' },
    });
    const note = chat.submit(request);
    expect(note.ok).toBe(true);
    expect(chat.submit(request)).toEqual(note);
    expect(f.store.conversations.atomic((tx) => tx.chatTurns())).toEqual([]);
  } finally {
    f.close();
  }
});
it('retains D cleanup holds after a root stop and review linkage, preventing a second slice', async () => {
  const f = roomTasks();
  try {
    const start = f.service.start(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value);
    const turn = f.store.conversations.atomic((tx) => tx.chatTurn(actor.turnId))!;
    f.db!.prepare('INSERT INTO ocean_reviews VALUES(?,?,?,?,?,?,?)').run(
      'review',
      f.input.workspaceId,
      'room',
      actor.taskRunId,
      actor.turnId,
      start.value.messageId,
      JSON.stringify({ id: 'review' }),
    );
    f.store.conversations.atomic((tx) =>
      tx.putChatTurn({ ...turn, status: 'dispatching', continuationReviewId: 'review' }),
    );
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.task(start.value.rootId)?.status),
    ).toBe('ready');
    expect(f.store.conversations.atomic((tx) => tx.roomPolicy('room'))).toBeNull();
    const reviewOnly = roomTaskCounts(f);
    expect(
      f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'review-only refusal' }),
    ).toMatchObject({ ok: false, error: { code: 'approval_required' } });
    expect(roomTaskCounts(f)).toEqual(reviewOnly);
    f.db!.prepare("UPDATE ocean_room_tasks SET status='stopped' WHERE id=?").run(
      start.value.rootId,
    );
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.roomHold('room'))).toBe(true);
    expect(f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'review source' }).ok).toBe(
      false,
    );
    f.store.conversations.atomic((tx) => {
      const input = tx.roomTasks!.deliveriesForReceipt(
        f.input.requestId,
        start.value.messageId,
      )[0]!;
      tx.roomTasks!.putDelivery({
        ...input,
        id: 'later-delivery',
        messageId: 'later-message',
        seq: 2,
        requestKey: 'later',
        position: 0,
      });
      const message = {
        id: 'later-message',
        workspaceId: f.input.workspaceId,
        roomId: 'room',
        seq: 2,
        author: 'user' as const,
        targetBotId: null,
        body: 'later',
        createdAt: 'now',
      };
      tx.putMessage(message);
      tx.putReceipt('later', { binding: 'later', reply: { kind: 'message', data: message } });
    });
    expect(() =>
      f.store.conversations.atomic((tx) =>
        tx.putChatTurn({
          ...turn,
          id: 'duplicate',
          taskRunId: 'tr_duplicate',
          inboundMessageId: 'later-message',
          readThroughSeq: 2,
          continuationReviewId: 'review',
          roomDelivery: { ...turn.roomDelivery!, deliveryId: 'later-delivery' },
        }),
      ),
    ).toThrow();
    expect(() =>
      f
        .db!.prepare(
          "UPDATE ocean_chat_turns SET status='completed',payload=json_set(payload,'$.status','completed') WHERE id=?",
        )
        .run(actor.turnId),
    ).toThrow('invalid room slice');
    // Synthetic terminal phase only; this fixture does not prove Core cleanup.
    f.db!.prepare(
      "UPDATE ocean_chat_turns SET status='cancelled',payload=json_set(payload,'$.status','cancelled') WHERE id=?",
    ).run(actor.turnId);
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.roomHold('room'))).toBe(false);
  } finally {
    f.close();
  }
});
it('blocks fresh work after a valid restored snapshot marker while preserving original receipts', async () => {
  const { sha256 } = await import('../test-fixtures/room-tasks.js');
  const f = roomTasks();
  try {
    const old = f.service.start(f.input);
    if (!old.ok) throw Error('start');
    const manifest = {
      format: 2 as const,
      createdAt: '2026-11-06T00:00:00Z',
      cli: 'fixture',
      node: 'fixture',
      sha256: 'a'.repeat(64),
      bytes: 4096,
      summary: {
        schema: 27,
        rooms: 1,
        messages: 1,
        positions: [{ roomId: 'room', sequence: 1 }],
        pendingEffects: 0,
        unfinishedRuns: 0,
        heldRooms: 1,
      },
      assets: {
        catalog: 'a'.repeat(64),
        codingInventory: 'a'.repeat(64),
        desktopInventory: 'a'.repeat(64),
        worktrees: 'a'.repeat(64),
        recovery: 'a'.repeat(64),
        dependencies: 'a'.repeat(64),
        desktop: null,
      },
    };
    f.store.restoration.install({
      version: 1,
      manifest,
      snapshotId: sha256(JSON.stringify(manifest)),
      profileRoot: '/disposable-restored-fixture',
      profileId: sha256('/disposable-restored-fixture'),
      sourceOwners: [],
    });
    expect(f.service.start({ ...f.input, requestId: 'copied' })).toMatchObject({
      ok: false,
      error: { code: 'recovery_required' },
    });
    expect(f.service.start(f.input)).toEqual(old);
  } finally {
    f.close();
  }
});

it('isolates text-only recovery refusal from transfer policy and source review', async () => {
  const f = roomTasks();
  try {
    const start = f.service.start(f.input);
    if (!start.ok) throw Error('start');
    const actor = await attachRoomActor(f, start.value);
    expect(f.service.start({ ...f.input, requestId: 'eligible-start' }).ok).toBe(true);
    expect(f.service.send(actor, { kind: 'message', toBotId: 'b', text: 'eligible send' }).ok).toBe(
      true,
    );
    f.db!.prepare('INSERT INTO ocean_reviews VALUES(?,?,?,?,?,?,?)').run(
      'policy-review',
      f.input.workspaceId,
      'room',
      actor.taskRunId,
      actor.turnId,
      start.value.messageId,
      JSON.stringify({ id: 'policy-review' }),
    );
    f.store.conversations.atomic((tx) =>
      tx.putRoomPolicy({ roomId: 'room', mode: 'text_only', reviewId: 'policy-review' }),
    );
    expect(f.store.conversations.atomic((tx) => tx.roomModelPolicy('room')?.cloudTransfer)).toBe(
      'allow',
    );
    expect(
      f.store.conversations.atomic((tx) => tx.chatTurn(actor.turnId)?.continuationReviewId),
    ).toBeUndefined();
    expect(
      f.store.conversations.atomic((tx) =>
        tx.roomTasks!.origin(actor.turnId, actor.taskRunId, actor.attemptId, true),
      ),
    ).not.toBeNull();
    const before = roomTaskCounts(f);
    expect(f.service.start({ ...f.input, requestId: 'restricted-start' })).toMatchObject({
      ok: false,
      error: { code: 'recovery_required' },
    });
    expect(
      f.service.send(
        { ...actor, callId: actor.callId + '-new' },
        { kind: 'message', toBotId: 'b', text: 'restricted send' },
      ),
    ).toMatchObject({ ok: false, error: { code: 'recovery_required' } });
    expect(roomTaskCounts(f)).toEqual(before);
  } finally {
    f.close();
  }
});
