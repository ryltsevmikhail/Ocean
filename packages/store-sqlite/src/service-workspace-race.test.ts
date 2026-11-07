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
it('joins postclaim evidence preparing past its deadline before returning not-started', async () => {
  let release!: () => void,
    entered!: () => void,
    done!: () => void,
    preparations = 0,
    lateClosed = 0,
    abortObserved!: () => void,
    finished = false;
  const aborted = new Promise<void>((r) => {
    abortObserved = r;
  });
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
      prepareResources: async (_admission, signal) => {
        if (++preparations === 2) {
          signal.addEventListener('abort', abortObserved, { once: true });
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
  const call = f.service.call(f.request).finally(() => {
    finished = true;
  });
  try {
    await waiting;
    await aborted;
    await new Promise<void>((r) => setImmediate(r));
    expect(finished).toBe(false);
  } finally {
    release();
    await call;
    await joined;
  }
  expect((await call).outcome?.kind).toBe('not_started');
  expect(lateClosed).toBe(1);
});
it('returns a proved preclaim deadline refusal while held preparation remains owned until late unwind', async () => {
  let release!: () => void,
    enter!: () => void,
    abortObserved!: () => void,
    closeObserved!: () => void,
    settled = false,
    closed = 0;
  const unwound = new Promise<void>((r) => {
    closeObserved = r;
  });
  const hold = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      enter = r;
    }),
    aborted = new Promise<void>((r) => {
      abortObserved = r;
    });
  const f = rig(
    async () => {
      throw Error('no dispatch allowed');
    },
    30,
    {
      prepareResources: async (_a, signal) => {
        signal.addEventListener('abort', abortObserved, { once: true });
        enter();
        await hold;
        return {
          facts: { pairs: [] },
          inspect: () => true,
          close: () => {
            closed++;
            closeObserved();
          },
        };
      },
    },
  );
  const call = f.service.call(f.request).then((value) => {
    settled = true;
    return value;
  });
  try {
    await entered;
    expect(f.authority.atomic((tx) => tx.connection('third')?.id)).toBe('third');
    await aborted;
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(true);
    expect(f.journal.inspectPending()).toEqual([]);
    expect(closed).toBe(0);
  } finally {
    release();
    await call;
    await unwound;
  }
  expect(closed).toBe(1);
});

it('fences the sent-uncertain generation before held proof close and awaits its joined retirement after unwind', async () => {
  let release!: () => void,
    entered!: () => void,
    unwound!: () => void,
    fenced = false,
    done = false;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    closing = new Promise<void>((r) => {
      entered = r;
    }),
    closed = new Promise<void>((r) => {
      unwound = r;
    });
  const f = rig(
    async (i) => {
      expect(i.authorizeDispatch()).toBe(true);
      return {
        kind: 'uncertain',
        code: 'transport_failure',
        invocationId: i.invocationId,
        detail: 'sent reply lost',
      };
    },
    2000,
    {
      prepareResources: async () => ({
        facts: { pairs: [] },
        inspect: () => true,
        close: async () => {
          entered();
          await held;
          unwound();
        },
      }),
    },
  );
  f.transport.retireUncertain = async () => {
    fenced = true;
    await closed;
  };
  const call = f.service.call(f.request).then((v) => {
    done = true;
    return v;
  });
  try {
    await closing;
    expect(fenced).toBe(true);
    expect(done).toBe(false);
  } finally {
    release();
    await call;
  }
  expect((await call).outcome?.kind).toBe('uncertain');
  expect(f.journal.inspectPending().map((r) => r.outcome)).toEqual(['uncertain']);
});
