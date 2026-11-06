import { expect, it } from 'vitest';
import { roomTasks } from '../test-fixtures/room-tasks.js';
it('commits an inert owner root, sibling tasks, message, deliveries and exact receipt', () => {
  const f = roomTasks();
  try {
    const first = f.service.start(f.input);
    expect(first.ok).toBe(true);
    if (first.ok)
      f.store.conversations.atomic((tx) => {
        const rt = tx.roomTasks!,
          root = rt.task(first.value.rootId);
        expect(root).toMatchObject({
          kind: 'root',
          status: 'ready',
          rootId: first.value.rootId,
          parentId: null,
          assigneeBotId: null,
          rootPayload: {
            limits: { concurrentSlices: 2, totalSlices: 32, providerStarts: 64, toolCalls: 64 },
          },
        });
        expect(
          rt
            .deliveriesForReceipt(f.input.requestId, first.value.messageId)
            .map((d) => [d.recipientBotId, d.state, d.position]),
        ).toEqual([
          ['a', 'queued', 0],
          ['b', 'queued', 1],
        ]);
        for (const d of first.value.deliveries)
          expect(rt.task(d.taskId)).toMatchObject({
            kind: 'bot',
            parentId: first.value.rootId,
            rootId: first.value.rootId,
            assigneeBotId: d.botId,
          });
      });
    expect(f.service.start(f.input)).toEqual(first);
    expect(f.store.conversations.atomic((tx) => tx.history('room', 0, 10))).toHaveLength(1);
    expect(f.store.conversations.atomic((tx) => tx.chatTurns())).toEqual([]);
  } finally {
    f.close();
  }
});
it('holds legacy broadcast admission while allowing independent roots', async () => {
  const { RoomBroadcastService } = await import('@runnets/application');
  const f = roomTasks();
  try {
    expect(f.service.start(f.input).ok).toBe(true);
    expect(f.service.start({ ...f.input, requestId: 'independent' }).ok).toBe(true);
    const broadcast = new RoomBroadcastService({
      store: f.store.conversations,
      clock: f.service.deps.clock,
      nextId: () => 'legacy',
    });
    expect(
      broadcast.submit({
        workspaceId: f.input.workspaceId,
        roomId: 'room',
        requestId: 'broadcast',
        text: 'old work',
      }),
    ).toMatchObject({ ok: false, error: { code: 'room_busy' } });
  } finally {
    f.close();
  }
});
it('reports D-held rooms without counting inert queued deliveries as Core runs', async () => {
  const { inspectDatabase } = await import('./maintenance.js');
  const f = roomTasks();
  try {
    expect(f.service.start(f.input).ok).toBe(true);
    const path = String(f.db!.prepare('PRAGMA database_list').get()?.['file']);
    expect(inspectDatabase(path)).toMatchObject({
      status: 'ok',
      summary: { heldRooms: 1, unfinishedRuns: 0, pendingEffects: 0 },
    });
  } finally {
    f.close();
  }
});
it('validates exact bounded intents before receipts, preserving opaque text and participant order', () => {
  const f = roomTasks();
  try {
    const text = '[Ocean Desktop attachments v1]\nopaque text';
    const input = { ...f.input, text },
      first = f.service.start(input);
    expect(first.ok).toBe(true);
    expect(f.store.conversations.atomic((tx) => tx.history('room', 0, 1)[0]?.body)).toBe(text);
    for (const bad of [
      { ...input, attachments: [] },
      { ...input, initialBotIds: ['a', 'a'] },
      { ...input, initialBotIds: ['missing'] },
      { ...input, text: 'x'.repeat(16385) },
      { ...input, participants: [input.participants[0]!, input.participants[0]!] },
    ])
      expect(f.service.start(bad)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(f.service.start({ ...input, text: 'changed' })).toMatchObject({
      ok: false,
      error: { code: 'request_conflict' },
    });
    const reversed = f.service.start({
      ...f.input,
      requestId: 'reverse',
      initialBotIds: ['b', 'a'],
      participants: [...f.input.participants].reverse(),
    });
    expect(reversed.ok).toBe(true);
    if (first.ok && reversed.ok) {
      const pins = (rootId: string) =>
        f.store.conversations.atomic((tx) => {
          const root = tx.roomTasks!.task(rootId);
          return root?.rootPayload?.members.slice().sort((a, b) => a.botId.localeCompare(b.botId));
        });
      expect(pins(first.value.rootId)).toEqual(pins(reversed.value.rootId));
    }
  } finally {
    f.close();
  }
});
it('accepts stored-workspace hash subjects and preserves both selected refs after revocation', async () => {
  const { ownerGrant } = await import('../../../test-fixtures/service-authority.js');
  const { sha256, attachRoomActor } = await import('../test-fixtures/room-tasks.js');
  const f = roomTasks();
  try {
    for (const id of ['grant-one', 'grant-two'])
      f.store.serviceAuthority.atomic((tx) =>
        tx.putGrant(
          {
            ...ownerGrant,
            id,
            subject: {
              ...ownerGrant.subject,
              workspaceId: f.input.workspaceId,
              roomId: 'room',
              botId: 'b',
              projectId: sha256('/fixture'),
            },
          },
          null,
        ),
      );
    const refs = [
      { grantId: 'grant-one', revision: 1 },
      { grantId: 'grant-two', revision: 1 },
    ];
    const input = {
      ...f.input,
      participants: f.input.participants.map((p) =>
        p.botId === 'b' ? { ...p, grantReferences: refs } : p,
      ),
    };
    expect(
      f.service.start({
        ...input,
        requestId: 'bad-project',
        mandate: { ...input.mandate, projectId: sha256('/elsewhere') },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    const started = f.service.start(input);
    if (!started.ok) throw Error('grant start');
    const actor = await attachRoomActor(f, started.value);
    f.store.serviceAuthority.atomic((tx) => {
      const old = tx.grant('grant-one')!;
      tx.putGrant({ ...old, revision: 2, state: 'revoked' }, 1);
    });
    expect(f.service.start({ ...input, requestId: 'stale' })).toMatchObject({
      ok: false,
      error: { code: 'approval_required' },
    });
    const sent = f.service.send(actor, {
      kind: 'delegate',
      toBotId: 'b',
      text: 'safe local communication',
    });
    expect(sent.ok).toBe(true);
    const root = f.store.conversations.atomic((tx) => tx.roomTasks!.task(started.value.rootId));
    expect(root?.rootPayload?.members.find((m) => m.botId === 'b')?.grantReferences).toEqual(refs);
  } finally {
    f.close();
  }
});
it('persists single-bot direct starts as a root plus its distinct child', () => {
  const f = roomTasks();
  try {
    f.store.conversations.atomic((tx) =>
      tx.putRoom({ id: 'direct', workspaceId: f.input.workspaceId, kind: 'direct', botId: 'a' }),
    );
    const started = f.service.start({
      ...f.input,
      roomId: 'direct',
      initialBotIds: ['a'],
      participants: [f.input.participants[0]!],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw Error('direct');
    expect(started.value.deliveries).toHaveLength(1);
    expect(started.value.deliveries[0]!.taskId).not.toBe(started.value.rootId);
    expect(f.store.conversations.atomic((tx) => tx.history('direct', 0, 1))).toMatchObject([
      { author: 'user', targetBotId: 'a' },
    ]);
  } finally {
    f.close();
  }
});
it('queues qualified local pins under deny without copying connection secrets', async () => {
  const f = roomTasks();
  try {
    const cloud = f.store.modelConnections.read('cloud')!;
    f.store.modelConnections.put(
      {
        ...cloud,
        connectionId: 'qualified',
        kind: 'local',
        auth: 'none',
        endpoint: 'http://127.0.0.1:1234',
        secretRef: null,
        localQualification: {
          modelId: 'one',
          artifactDigest: 'a'.repeat(64),
          backendVersion: 'fixture',
          configuredContextTokens: 4096,
          capabilities: {
            tools: true,
            streaming: true,
            inputModalities: ['text'],
            contextTokens: 4096,
            maxOutputTokens: null,
            usage: 'unavailable',
          },
        },
      },
      null,
    );
    f.store.conversations.atomic((tx) => {
      tx.putModelBinding('a', { connectionId: 'qualified', modelId: 'one' });
      tx.putRoomModelPolicy({ roomId: 'room', cloudTransfer: 'deny', revision: 2 });
    });
    const started = f.service.start({
      ...f.input,
      initialBotIds: ['a'],
      participants: [f.input.participants[0]!],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw Error('local');
    const root = f.store.conversations.atomic((tx) => tx.roomTasks!.task(started.value.rootId));
    expect(root?.rootPayload?.members[0]?.identity).toMatchObject({
      kind: 'local',
      artifactDigest: 'a'.repeat(64),
      backendVersion: 'fixture',
    });
    expect(JSON.stringify(root)).not.toContain('secretRef');
  } finally {
    f.close();
  }
});
it('permits a waiting owner root with no bot waiting-child binding and keeps its room held', () => {
  const f = roomTasks();
  try {
    const started = f.service.start(f.input);
    if (!started.ok) throw Error('start');
    expect(() =>
      f
        .db!.prepare("UPDATE ocean_room_tasks SET status='waiting' WHERE id=?")
        .run(started.value.rootId),
    ).not.toThrow();
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.task(started.value.rootId)),
    ).toMatchObject({ kind: 'root', status: 'waiting', waitingChildId: null });
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.roomHold('room'))).toBe(true);
  } finally {
    f.close();
  }
});
