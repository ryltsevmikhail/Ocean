import { expect, it } from 'vitest';
import { ServiceCallAdmissionService } from '@runnets/application';
import { roomSlices, roomServiceSlices, usage, answer } from '../test-fixtures/room-slices.js';
import { attachRoomActor } from '../test-fixtures/room-tasks.js';
import type { ProviderEvent } from '@runnets/application';
it('serializes two different run claims at64 physical calls and never replays the winning effect', async () => {
  const f = roomServiceSlices(100);
  try {
    const started = f.service.startHosted({
      ...f.input,
      initialBotIds: ['a', 'b'],
      participants: f.grants.map((g) => ({
        botId: g.subject.botId,
        grantReferences: [{ grantId: g.id, revision: g.revision }],
      })),
      mandate: { projectId: null, codingTaskId: null, permissions: f.grants[0]!.permissions },
    });
    if (!started.ok) throw Error('start');
    expect(
      f.service.startHosted({
        ...f.input,
        requestId: 'room-fence/v1:' + f.deps.sha256(started.value.rootId),
      }).ok,
    ).toBe(true);
    const a = await attachRoomActor(f, started.value, 'a'),
      b = await attachRoomActor(f, started.value, 'b');
    let sends = 0;
    const service = new ServiceCallAdmissionService({
      store: f.store.serviceAuthority,
      now: () => f.deps.clock.now().getTime(),
      restored: false,
      classify: () => ({
        scope: { kind: 'resources', resources: [{ kind: 'connection', connectionId: 'third' }] },
        effectKind: 'observation',
      }),
      transport: {
        async invoke(input) {
          if (!input.authorizeDispatch())
            return {
              kind: 'not_started',
              code: 'execution_disabled',
              invocationId: input.invocationId,
              detail: 'denied',
            };
          sends++;
          return {
            kind: 'observed',
            code: 'ok',
            invocationId: input.invocationId,
            result: true,
            vendorErrorCode: null,
          };
        },
      },
    });
    for (let i = 0; i < 63; i++)
      expect(
        (await service.call({ ...f.request(a), invocationId: a.callId + '_' + i })).outcome?.kind,
      ).toBe('observed');
    const calls = [
      { ...f.request(a), invocationId: a.callId + '_last' },
      { ...f.request(b, 'b'), invocationId: b.callId + '_last' },
    ];
    const results = await Promise.all(calls.map((request) => service.call(request)));
    expect(results.filter((r) => r.outcome?.kind === 'observed')).toHaveLength(1);
    expect(sends).toBe(64);
    await Promise.all(calls.map((request) => service.call(request)));
    expect(sends).toBe(64);
    expect(f.db!.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(64);
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.projection(started.value.rootId)),
    ).toMatchObject({
      status: 'paused',
      fenceReason: { code: 'tool_limit' },
      counts: { toolCalls: 64 },
    });
  } finally {
    f.close();
  }
});
it('serializes remaining slice claims at32 without refunding admitted identities', async () => {
  const rounds: ProviderEvent[][] = [],
    f = roomSlices(rounds, []);
  try {
    const started = f.service.startHosted({ ...f.input, initialBotIds: ['a', 'c'] });
    if (!started.ok) throw Error('start');
    let delivery = started.value.deliveries[0]!.deliveryId;
    for (let index = 0; index < 31; index++) {
      rounds.push(
        [
          {
            type: 'tool_call',
            call: {
              id: 'send',
              name: 'room_send',
              arguments: JSON.stringify({
                toBotId: index % 2 === 0 ? 'b' : 'a',
                text: 'next ' + index,
              }),
            },
          },
          usage,
          { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' },
        ],
        [...answer('sent')],
      );
      const turn = await f.execute(delivery);
      const child = f.store.conversations.atomic((tx) =>
        tx
          .roomTasks!.tasks(started.value.rootId)
          .find((t) => t.parentId === turn.roomDelivery!.taskId),
      )!;
      delivery = f.deliveries(child.id)[0]!.id;
    }
    const claims = await Promise.all(
      [delivery, started.value.deliveries[1]!.deliveryId].map(async (id) => f.claim(id)),
    );
    expect(claims.map((c) => c.kind).sort()).toEqual(['claimed', 'held']);
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.projection(started.value.rootId)),
    ).toMatchObject({
      status: 'paused',
      fenceReason: { code: 'slice_limit' },
      counts: { slices: 32, active: 1 },
    });
    expect(f.claim(delivery).kind).toBe('existing');
    expect(f.requests).toHaveLength(62);
  } finally {
    f.close();
  }
}, 15000);
