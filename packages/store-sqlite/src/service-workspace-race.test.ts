import { expect, it } from 'vitest';
import { rig } from '../test-fixtures/service-call-rig.js';
it('rechecks the grant call budget after asynchronous physical preparation before claim', async () => {
  let release!: () => void,
    entered!: () => void,
    preparations = 0,
    sends = 0;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const f = rig(
    async (i) => {
      if (!i.authorizeDispatch()) throw Error('denied');
      sends++;
      return {
        kind: 'observed',
        code: 'ok',
        result: null,
        vendorErrorCode: null,
        invocationId: i.invocationId,
      };
    },
    2000,
    {
      prepareResources: async () => {
        if (++preparations === 1) {
          entered();
          await held;
        }
        return { facts: { pairs: [] }, inspect: () => true, close: () => {} };
      },
    },
  );
  f.owners.revise(f.request.grantReference, {
    ...f.intent,
    limits: { ...f.intent.limits, maxCalls: 1 },
  });
  const request = { ...f.request, grantReference: { grantId: 'grant', revision: 2 } };
  const first = f.service.call({ ...request, invocationId: 'first' });
  await waiting;
  expect((await f.service.call({ ...request, invocationId: 'second' })).outcome?.kind).toBe(
    'observed',
  );
  release();
  expect((await first).outcome).toBe(null);
  expect(sends).toBe(1);
});
it.each(['revoke', 'unknown', 'connection'] as const)(
  'denies after held physical preparation and a concurrent %s change',
  async (mode) => {
    let release!: () => void,
      entered!: () => void,
      sends = 0;
    const held = new Promise<void>((r) => {
        release = r;
      }),
      waiting = new Promise<void>((r) => {
        entered = r;
      });
    const f = rig(
      async (i) => {
        if (i.authorizeDispatch()) sends++;
        throw Error('must not send');
      },
      2000,
      {
        prepareResources: async () => {
          entered();
          await held;
          return { facts: { pairs: [] }, inspect: () => true, close: () => {} };
        },
      },
    );
    const call = f.service.call(f.request);
    await waiting;
    if (mode === 'revoke') f.owners.revoke(f.request.grantReference);
    else if (mode === 'unknown')
      expect(
        f.journal.claimNow(
          'unknown',
          'legacy',
          { taskRunId: 'other', attemptId: 'other' },
          'unknown',
        ),
      ).toBe(true);
    else
      f.authority.atomic((tx) => {
        const c = tx.connection('third')!;
        tx.putConnection({ ...c, state: 'disconnected', configRevision: c.configRevision + 1 }, c);
      });
    release();
    expect((await call).outcome).toBe(null);
    expect(sends).toBe(0);
  },
);
it('closes physical evidence that finishes preparing after its outer call deadline', async () => {
  let release!: () => void,
    entered!: () => void,
    done!: () => void,
    preparations = 0,
    lateClosed = 0;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    waiting = new Promise<void>((r) => {
      entered = r;
    }),
    joined = new Promise<void>((r) => {
      done = r;
    });
  const f = rig(
    async (i) => {
      try {
        await i.prepareDispatch?.();
        return {
          kind: 'not_started',
          code: 'execution_disabled',
          invocationId: i.invocationId,
          detail: 'test',
        };
      } finally {
        done();
      }
    },
    30,
    {
      prepareResources: async () => {
        if (++preparations === 2) {
          entered();
          await held;
          return {
            facts: { pairs: [] },
            inspect: () => true,
            close: () => {
              lateClosed++;
            },
          };
        }
        return { facts: { pairs: [] }, inspect: () => true, close: () => {} };
      },
    },
  );
  const call = f.service.call(f.request);
  await waiting;
  expect((await call).outcome?.kind).toBe('not_started');
  release();
  await joined;
  expect(lateClosed).toBe(1);
});
