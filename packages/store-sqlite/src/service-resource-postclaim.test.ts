import { expect, it, vi } from 'vitest';
import { rig } from '../test-fixtures/service-call-rig.js';
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
it.each([
  ['cancel', 'prior-close'],
  ['deadline', 'prior-close'],
  ['cancel', 'final-prepare'],
  ['deadline', 'final-prepare'],
] as const)('joins postclaim %s during %s and retains the cleanup failure', async (mode, phase) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const held = barrier(),
    entered = barrier(),
    aborted = barrier();
  const controller = new AbortController();
  const closeFailure = Error('PRIVATE_CLOSE'),
    operationFailure = Error('PRIVATE_PREPARE');
  const aggregate = new AggregateError([operationFailure, closeFailure]);
  let prepared = 0,
    sends = 0,
    done = false,
    priorFinished = false,
    replacementClosed = false;
  const f = rig(
    async (input) => {
      input.signal.addEventListener('abort', aborted.release, { once: true });
      await input.prepareDispatch?.();
      if (input.authorizeDispatch()) sends++;
      throw Error('must not send');
    },
    1000,
    {
      prepareResources: async () => {
        const n = ++prepared;
        if (n === 2 && phase === 'final-prepare') {
          entered.release();
          await held.promise;
          throw aggregate;
        }
        return {
          facts: { pairs: [] },
          inspect: () => true,
          close: async () => {
            if (n === 1 && phase === 'prior-close') {
              entered.release();
              await held.promise;
              priorFinished = true;
              throw closeFailure;
            }
            if (n === 2) replacementClosed = true;
          },
        };
      },
    },
  );
  const call = f.service.call(f.request, controller.signal).finally(() => {
    done = true;
  });
  try {
    await entered.promise;
    expect(f.journal.inspectPending()[0]!.outcome).toBe('started');
    if (mode === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(1000);
    await aborted.promise;
    await turn();
    expect(sends).toBe(0);
    expect(done).toBe(false);
    expect(priorFinished).toBe(false);
    expect(f.journal.inspectPending()[0]!.outcome).toBe('started');
  } finally {
    held.release();
    await call;
    vi.useRealTimers();
  }
  const result = await call;
  expect(result.outcome?.kind).toBe('not_started');
  expect(result.cleanupError?.errors).toContain(phase === 'prior-close' ? closeFailure : aggregate);
  expect(prepared).toBe(2);
  expect(sends).toBe(0);
  if (phase === 'prior-close') {
    expect(priorFinished).toBe(true);
    expect(replacementClosed).toBe(true);
  }
  expect(
    f.db.prepare('SELECT outcome FROM tool_invocations_v2 WHERE id=?').get(f.request.invocationId)![
      'outcome'
    ],
  ).toBe('not_started');
});
it('retains operation and cleanup aggregate when final preparation rejects without cancellation', async () => {
  const operation = Error('PRIVATE_OPERATION'),
    cleanup = Error('PRIVATE_CLEANUP');
  const aggregate = new AggregateError([operation, cleanup]);
  let prepared = 0,
    closed = 0,
    sends = 0;
  const f = rig(
    async (input) => {
      await input.prepareDispatch?.();
      if (input.authorizeDispatch()) sends++;
      throw Error('must not send');
    },
    2000,
    {
      prepareResources: async () => {
        if (++prepared === 2) throw aggregate;
        return {
          facts: { pairs: [] },
          inspect: () => true,
          close: () => {
            closed++;
          },
        };
      },
    },
  );
  const result = await f.service.call(f.request);
  expect(result.outcome?.kind).toBe('not_started');
  expect(result.cleanupError?.errors).toEqual([aggregate]);
  expect(aggregate.errors).toEqual([operation, cleanup]);
  expect(sends).toBe(0);
  expect(closed).toBe(1);
  expect(f.journal.inspectPending()).toEqual([]);
});
it('fences uncertain dispatch before joining its own held swap and closes proof before retirement join', async () => {
  const entered = barrier(),
    held = barrier(),
    fenced = barrier(),
    proofsClosed = barrier();
  const controller = new AbortController();
  let prepared = 0,
    closed = 0,
    done = false,
    retired = false;
  const f = rig(
    async (input) => {
      expect(input.authorizeDispatch()).toBe(true);
      await input.prepareDispatch?.();
      throw Error('response lost');
    },
    2000,
    {
      prepareResources: async () => {
        const n = ++prepared;
        return {
          facts: { pairs: [] },
          inspect: () => true,
          close: async () => {
            if (n === 1) {
              entered.release();
              await held.promise;
            }
            if (++closed === 2) proofsClosed.release();
          },
        };
      },
    },
  );
  f.transport.retireUncertain = async () => {
    fenced.release();
    await proofsClosed.promise;
    retired = true;
  };
  const call = f.service.call(f.request, controller.signal).finally(() => {
    done = true;
  });
  try {
    await entered.promise;
    controller.abort();
    await fenced.promise;
    await turn();
    expect(done).toBe(false);
    expect(closed).toBe(0);
    expect(retired).toBe(false);
  } finally {
    held.release();
    await call;
  }
  expect(closed).toBe(2);
  expect(retired).toBe(true);
  expect((await call).outcome?.kind).toBe('uncertain');
  expect(f.journal.inspectPending()[0]!.outcome).toBe('uncertain');
});
it('does not join unrelated transport waiting or start fresh proof work after cancellation', async () => {
  const entered = barrier(),
    held = barrier(),
    invocationFinished = barrier();
  const controller = new AbortController();
  let prepared = 0,
    closed = 0,
    done = false,
    sends = 0,
    denied = false;
  const f = rig(
    async (input) => {
      entered.release();
      await held.promise;
      try {
        await input.prepareDispatch?.();
        if (input.authorizeDispatch()) sends++;
      } catch {
        denied = true;
      } finally {
        invocationFinished.release();
      }
      throw Error('transport stopped');
    },
    2000,
    {
      prepareResources: async () => {
        prepared++;
        return {
          facts: { pairs: [] },
          inspect: () => true,
          close: () => {
            closed++;
          },
        };
      },
    },
  );
  const call = f.service.call(f.request, controller.signal).finally(() => {
    done = true;
  });
  try {
    await entered.promise;
    controller.abort();
    await turn();
    expect(done).toBe(true);
    expect(prepared).toBe(1);
    expect(closed).toBe(1);
  } finally {
    held.release();
    await invocationFinished.promise;
    await call;
  }
  expect(denied).toBe(true);
  expect(sends).toBe(0);
  expect(prepared).toBe(1);
  expect((await call).outcome?.kind).toBe('not_started');
});
