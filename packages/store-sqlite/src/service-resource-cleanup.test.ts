import { expect, it, vi } from 'vitest';
import { SqliteToolJournal } from './tool-journal.js';
import { rig } from '../test-fixtures/service-call-rig.js';
it('settles a sent-uncertain row despite rejected proof close and joins exact held retirement before returning', async () => {
  let release!: () => void,
    entered!: () => void,
    retired = false,
    finished = false;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    retirement = new Promise<void>((r) => {
      entered = r;
    });
  const failure = Error('private proof close failure');
  const f = rig(
    async (i) => {
      expect(i.authorizeDispatch()).toBe(true);
      return {
        kind: 'uncertain',
        code: 'transport_failure',
        invocationId: i.invocationId,
        detail: 'reply lost',
      };
    },
    2000,
    {
      prepareResources: async () => ({
        facts: { pairs: [] },
        inspect: () => true,
        close: async () => {
          throw failure;
        },
      }),
    },
  );
  f.transport.retireUncertain = async () => {
    entered();
    await held;
    retired = true;
  };
  const call = f.service
    .call(f.request)
    .then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      finished = true;
    });
  try {
    await retirement;
    await new Promise<void>((r) => setImmediate(r));
    expect(finished).toBe(false);
    expect(f.journal.inspectPending().map((r) => r.outcome)).toEqual(['uncertain']);
  } finally {
    release();
    await call;
  }
  const result = await call;
  expect(retired).toBe(true);
  expect(result).toHaveProperty('result.outcome.kind', 'uncertain');
  expect(result).toHaveProperty('result.cleanupError');
  if ('result' in result) expect(result.result.cleanupError?.errors).toContain(failure);
});

it.each(['ok', 'vendor_error', 'not_started'] as const)(
  'keeps the %s operation result and durable truth when proof close fails',
  async (kind) => {
    const failure = Error('private known-result cleanup failure');
    let retired = false;
    const f = rig(
      async (i) => {
        if (kind === 'not_started')
          return {
            kind: 'not_started',
            code: 'execution_disabled',
            invocationId: i.invocationId,
            detail: 'not sent',
          };
        expect(i.authorizeDispatch()).toBe(true);
        return {
          kind: 'observed',
          code: kind,
          invocationId: i.invocationId,
          result: { known: kind },
          vendorErrorCode: kind === 'ok' ? null : 'rejected',
        };
      },
      2000,
      {
        prepareResources: async () => ({
          facts: { pairs: [] },
          inspect: () => true,
          close: async () => {
            throw failure;
          },
        }),
      },
    );
    f.transport.retireUncertain = async () => {
      retired = true;
    };
    const result = await f.service.call(f.request);
    expect(result.outcome?.kind).toBe(kind === 'not_started' ? 'not_started' : 'observed');
    expect(result.code).toBe(kind === 'not_started' ? 'execution_disabled' : kind);
    expect(result.cleanupError?.errors).toContain(failure);
    expect(retired).toBe(false);
    expect(
      f.db
        .prepare('SELECT outcome FROM tool_invocations_v2 WHERE id=?')
        .get(f.request.invocationId)!['outcome'],
    ).toBe(kind === 'ok' ? 'completed' : kind === 'vendor_error' ? 'failed' : 'not_started');
  },
);
it('joins retirement even when close and durable settlement fail, retaining every cause without pretending settlement succeeded', async () => {
  const closeFailure = Error('close failure'),
    settleFailure = Error('settle failure'),
    retireFailure = Error('retire failure');
  let release!: () => void,
    entered!: () => void,
    done = false;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    retiring = new Promise<void>((r) => {
      entered = r;
    });
  const f = rig(
    async (i) => {
      expect(i.authorizeDispatch()).toBe(true);
      return {
        kind: 'uncertain',
        code: 'transport_failure',
        invocationId: i.invocationId,
        detail: 'lost',
      };
    },
    2000,
    {
      prepareResources: async () => ({
        facts: { pairs: [] },
        inspect: () => true,
        close: async () => {
          throw closeFailure;
        },
      }),
    },
  );
  const settle = vi.spyOn(SqliteToolJournal.prototype, 'settleNow').mockImplementation(() => {
    throw settleFailure;
  });
  f.transport.retireUncertain = async () => {
    entered();
    await held;
    throw retireFailure;
  };
  const call = f.service.call(f.request).finally(() => {
    done = true;
  });
  try {
    await retiring;
    await new Promise<void>((r) => setImmediate(r));
    expect(done).toBe(false);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(f.journal.inspectPending()[0]!.outcome).toBe('started');
  } finally {
    release();
    await call;
    settle.mockRestore();
  }
  const result = await call;
  expect(result.outcome?.kind).toBe('uncertain');
  expect(result.cleanupError?.errors).toEqual([closeFailure, settleFailure, retireFailure]);
});
it('retains a prior proof close failure, denies dispatch, and still closes its replacement proof', async () => {
  let prepared = 0,
    closed = 0,
    sends = 0;
  const failure = Error('prior close failure');
  const f = rig(
    async (i) => {
      await i.prepareDispatch?.();
      if (i.authorizeDispatch()) sends++;
      throw Error('must not dispatch');
    },
    2000,
    {
      prepareResources: async () => {
        const n = ++prepared;
        return {
          facts: { pairs: [] },
          inspect: () => true,
          close: async () => {
            closed++;
            if (n === 1) throw failure;
          },
        };
      },
    },
  );
  const result = await f.service.call(f.request);
  expect(sends).toBe(0);
  expect(prepared).toBe(2);
  expect(closed).toBe(2);
  expect(result.outcome?.kind).toBe('not_started');
  expect(result.cleanupError?.errors).toEqual([failure]);
  expect(f.journal.inspectPending()).toEqual([]);
});

it('retains an initial preparation aggregate after every owned close attempt has failed or unwound', async () => {
  const failure = new AggregateError([
    Error('preparation failed'),
    new AggregateError([Error('close failed')]),
  ]);
  let sends = 0;
  const f = rig(
    async () => {
      sends++;
      throw Error('must not send');
    },
    2000,
    {
      prepareResources: async () => {
        throw failure;
      },
    },
  );
  const result = await f.service.call(f.request);
  expect(result.code).toBe('claim_refused');
  expect(result.outcome).toBe(null);
  expect(result.cleanupError?.errors).toEqual([failure]);
  expect(sends).toBe(0);
  expect(f.journal.inspectPending()).toEqual([]);
});
