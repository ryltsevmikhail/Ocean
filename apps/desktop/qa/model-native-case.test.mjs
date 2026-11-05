import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { seedModelSettings } from './model-native-seed.mjs';
import { createNativeCase } from './model-native-case.mjs';

test('expiry closes and drains a delayed check before returning; no subsequent mutations', async () => {
  const calls = [];
  const pending = Promise.withResolvers();
  const retired = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const peer = {
    setModelConnection: async () => {
      calls.push('save');
    },
    checkModelConnection: async () => {
      calls.push('check');
      return pending.promise;
    },
    createBoundBot: async () => {
      calls.push('create');
    },
  };
  const control = createNativeCase();
  let lateStep;
  const run = control.run(
    async (step) => {
      lateStep = step;
      await seedModelSettings(peer, { connectionCount: 2, botCount: 1, step });
    },
    100,
    async () => {
      calls.push('close');
      closing.resolve();
      pending.resolve({ check: { outcome: 'ok' } });
      await retired.promise;
    },
  );
  await closing.promise;
  await delay(0);
  assert.deepEqual(calls, ['save', 'check', 'close']);
  let finished = false;
  void run.catch(() => {
    finished = true;
  });
  await delay(0);
  assert.equal(finished, false);
  retired.resolve();
  await assert.rejects(run, /timed out/);
  assert.deepEqual(calls, ['save', 'check', 'close']);
  assert.throws(() => lateStep(() => calls.push('late UI click')), /timed out/);
  await assert.rejects(
    control.run(
      () => calls.push('another case'),
      100,
      async () => {},
    ),
    /timed out|used/,
  );
  assert.deepEqual(calls, ['save', 'check', 'close']);
});

test('an interrupted case waits for its pending operation even when transport cleanup finishes first', async () => {
  const control = createNativeCase();
  const issued = Promise.withResolvers(),
    pending = Promise.withResolvers(),
    closed = Promise.withResolvers();
  let settled = false,
    followups = 0;
  const run = control.run(
    async (step) => {
      await step(() => {
        issued.resolve();
        return pending.promise;
      });
      step(() => {
        followups++;
      });
    },
    5000,
    async () => {
      closed.resolve();
    },
  );
  const outcome = run.catch((error) => {
    settled = true;
    return error;
  });
  await issued.promise;
  const cause = Error('logger EIO');
  control.fail(cause);
  await closed.promise;
  await delay(0);
  assert.equal(settled, false);
  pending.resolve();
  assert.equal(await outcome, cause);
  assert.equal(followups, 0);
});

test('a successful flow returns its value and closes its operation gate', async () => {
  const control = createNativeCase();
  let late;
  const value = await control.run(
    async (step) => {
      late = step;
      return step(() => 42);
    },
    500,
    async () => assert.fail('unexpected retirement'),
  );
  assert.equal(value, 42);
  assert.throws(() => late(() => assert.fail('late mutation')), /finished/);
});
