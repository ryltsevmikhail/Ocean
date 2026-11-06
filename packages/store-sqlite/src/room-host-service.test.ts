import { expect, it } from 'vitest';
import { ServiceCallAdmissionService } from '@runnets/application';
import { roomSlices } from '../test-fixtures/room-slices.js';
import { attachRoomActor } from '../test-fixtures/room-tasks.js';
import {
  ownerGrant,
  serviceConnection,
  serviceCatalog,
} from '../../../test-fixtures/service-authority.js';
it('actual C claim refuses an available service grant outside the captured room mandate and refs', async () => {
  const f = roomSlices([]);
  try {
    const start = f.start(),
      actor = await attachRoomActor(f, start);
    const grant = {
      ...ownerGrant,
      id: 'rogue',
      subject: {
        workspaceId: 'ws_fixture',
        roomId: 'room',
        botId: 'a',
        projectId: f.deps.sha256('/fixture'),
        taskId: null,
      },
      permissions: ownerGrant.permissions.map((p) =>
        p.kind === 'service' ? { ...p, baselineCatalogId: 'catalog' } : p,
      ),
    };
    f.store.serviceAuthority.atomic((tx) => {
      expect(tx.putConnection(serviceConnection, null)).toBe(true);
      expect(tx.putCatalog(serviceCatalog)).toBe(true);
      expect(tx.publishCatalog('third', serviceConnection, 'catalog')).toBe(true);
      expect(tx.putGrant(grant, null)).toBe(true);
    });
    let sends = 0;
    const service = new ServiceCallAdmissionService({
      store: f.store.serviceAuthority,
      now: () => f.deps.clock.now().getTime(),
      restored: false,
      transport: {
        async invoke(input) {
          if (input.authorizeDispatch()) sends++;
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
    const result = await service.call({
      ...grant.subject,
      connectionId: 'third',
      catalogId: 'catalog',
      tool: 'notes.search',
      arguments: {},
      grantReference: { grantId: grant.id, revision: 1 },
      taskRunId: actor.taskRunId,
      attemptId: actor.attemptId,
      invocationId: actor.callId,
    });
    expect(result.outcome).toBeNull();
    expect(sends).toBe(0);
    expect(f.db!.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(0);
  } finally {
    f.close();
  }
});

import { roomServiceSlices } from '../test-fixtures/room-slices.js';
it('journals the executor basis and shares one original issuing-run grant debit across message children', async () => {
  const f = roomServiceSlices(1);
  try {
    const start = f.startService(),
      a = await attachRoomActor(f, start);
    const first = f.service.send(a, { kind: 'message', toBotId: 'b', text: 'first' });
    const second = f.service.send(
      { ...a, callId: a.callId + '_second' },
      { kind: 'message', toBotId: 'b', text: 'second' },
    );
    if (!first.ok || !second.ok) throw Error('message admission');
    const b1 = await attachRoomActor(f, first.value, 'b'),
      b2 = await attachRoomActor(f, second.value, 'b');
    let sends = 0;
    const service = new ServiceCallAdmissionService({
      store: f.store.serviceAuthority,
      now: () => f.deps.clock.now().getTime(),
      restored: false,
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
    expect((await service.call(f.request(b1, 'b'))).outcome?.kind).toBe('observed');
    expect((await service.call(f.request(b2, 'b'))).outcome).toBeNull();
    expect(sends).toBe(1);
    const admission = JSON.parse(
      String(f.db!.prepare('SELECT admission FROM tool_invocations_v2').get()?.['admission']),
    );
    expect(admission.binding.roomBasis).toEqual([
      {
        chargedRunId: b1.taskRunId,
        subject: f.grants[1]!.subject,
        grantId: 'grant_b',
        revision: 1,
      },
      { chargedRunId: a.taskRunId, subject: f.grants[0]!.subject, grantId: 'grant_a', revision: 1 },
    ]);
    expect(f.store.conversations.atomic((tx) => tx.roomTasks!.counts(start.rootId).toolCalls)).toBe(
      3,
    );
  } finally {
    f.close();
  }
});
it('charges and dispatches exactly 64 actual physical claims then freezes the root once', async () => {
  const f = roomServiceSlices(100);
  try {
    const start = f.startService(),
      actor = await attachRoomActor(f, start);
    let sends = 0;
    const service = new ServiceCallAdmissionService({
      store: f.store.serviceAuthority,
      now: () => f.deps.clock.now().getTime(),
      restored: false,
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
    for (let i = 0; i < 64; i++)
      expect(
        (await service.call({ ...f.request(actor), invocationId: actor.callId + '_' + i })).outcome
          ?.kind,
      ).toBe('observed');
    expect(
      (await service.call({ ...f.request(actor), invocationId: actor.callId + '_65' })).outcome,
    ).toBeNull();
    expect(sends).toBe(64);
    expect(
      f.store.conversations.atomic((tx) => tx.roomTasks!.projection(start.rootId)),
    ).toMatchObject({
      status: 'paused',
      counts: { toolCalls: 64 },
      fenceReason: { code: 'tool_limit' },
    });
    expect(f.db!.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(64);
  } finally {
    f.close();
  }
});
it.each(['confirmation', 'dispatch'] as const)(
  'revokes captured issuer authority during asynchronous %s without an effect',
  async (phase) => {
    const f = roomServiceSlices(10, phase === 'confirmation' ? 'confirm' : 'autonomous');
    try {
      const a = await attachRoomActor(f, f.startService());
      const sent = f.service.send(a, { kind: 'message', toBotId: 'b', text: 'child' });
      if (!sent.ok) throw Error('child');
      const b = await attachRoomActor(f, sent.value, 'b');
      let entered!: () => void,
        release!: () => void,
        sends = 0;
      const ready = new Promise<void>((r) => {
          entered = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      const service = new ServiceCallAdmissionService({
        store: f.store.serviceAuthority,
        now: () => f.deps.clock.now().getTime(),
        restored: false,
        confirmation: {
          async confirm(_operation, _signal, current) {
            entered();
            await gate;
            expect(await current()).toBe(false);
            return 'allowed';
          },
        },
        transport: {
          async invoke(input) {
            entered();
            await gate;
            const allowed = input.authorizeDispatch();
            if (allowed) sends++;
            return {
              kind: 'not_started',
              code: 'execution_disabled',
              invocationId: input.invocationId,
              detail: 'denied',
            };
          },
        },
      });
      const call = service.call(f.request(b, 'b'));
      await ready;
      f.store.serviceAuthority.atomic((tx) => {
        const g = tx.grant('grant_a')!;
        expect(tx.putGrant({ ...g, state: 'revoked', revision: 2 }, 1)).toBe(true);
      });
      release();
      const result = await call;
      expect(phase === 'confirmation' ? result.outcome : result.outcome?.kind).toBe(
        phase === 'confirmation' ? null : 'not_started',
      );
      expect(sends).toBe(0);
      expect(f.db!.prepare('SELECT count(*) AS n FROM tool_invocations_v2').get()?.['n']).toBe(
        phase === 'confirmation' ? 0 : 1,
      );
    } finally {
      f.close();
    }
  },
);
