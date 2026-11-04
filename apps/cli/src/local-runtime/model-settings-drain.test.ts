import { assertRuntimeDrained } from './drain-supervision.js';
import { expect, it, vi } from 'vitest';
import { ModelSettings, type ModelSettingsServices } from './model-settings.js';
function fixture() {
  const services = {
    connections: { check: vi.fn(), set: vi.fn(), disconnect: vi.fn(), removeSavedKey: vi.fn() },
    metadata: { list: vi.fn() },
    bindings: { create: vi.fn(), set: vi.fn() },
    bots: { list: vi.fn() },
    policy: { get: vi.fn(), set: vi.fn() },
    execution: { get: vi.fn() },
  } satisfies ModelSettingsServices;
  return { services, settings: new ModelSettings(services, true), signal: new AbortController() };
}
it.each(['check', 'get'] as const)(
  'joins a detached %s until settled and closes admission before drain',
  async (kind) => {
    const f = fixture();
    let resolve!: (value: never) => void;
    const gate = new Promise<never>((r) => {
      resolve = r;
    });
    const method = kind === 'check' ? 'modelConnections.check' : 'runs.modelExecution';
    const params =
      kind === 'check' ? { connectionId: 'c' } : { workspaceId: 'w', roomId: 'r', runId: 'run' };
    if (kind === 'check') f.services.connections.check.mockReturnValue(gate);
    else f.services.execution.get.mockReturnValue(gate);
    const job = f.settings.dispatch(method, params, f.signal.signal);
    f.signal.abort();
    let drained = false;
    const drain = f.settings.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(await f.settings.dispatch(method, params, f.signal.signal)).toEqual({
      error: { code: 'runtime_draining' },
    });
    resolve({ value: 'settled' } as never);
    await drain;
    expect(await job).toEqual({ result: { value: 'settled' } });
  },
);
it('sanitizes synchronous and asynchronous unknown failures, including lowercase secret text', async () => {
  const f = fixture();
  f.services.connections.disconnect.mockImplementation(() => {
    throw Error('private_lowercase_sentinel');
  });
  expect(
    await f.settings.dispatch(
      'modelConnections.disconnect',
      { connectionId: 'c', requestId: 'r', expectedRevision: 1 },
      f.signal.signal,
    ),
  ).toEqual({ error: { code: 'runtime_failure' } });
  f.services.connections.check.mockRejectedValue(Error('private_lowercase_sentinel'));
  expect(
    await f.settings.dispatch('modelConnections.check', { connectionId: 'c' }, f.signal.signal),
  ).toEqual({ error: { code: 'runtime_failure' } });
  await expect(f.settings.drain()).resolves.toBe('settled');
});
it('supervises synchronous settings operations and refuses restore maintenance before service invocation', async () => {
  const f = fixture();
  const settings = new ModelSettings(f.services, false);
  const input = {
    workspaceId: 'w',
    roomId: 'r',
    requestId: 'x',
    expectedRevision: 1,
    cloudTransfer: 'allow',
  };
  expect(await settings.dispatch('rooms.setModelPolicy', input, f.signal.signal)).toEqual({
    error: { code: 'restore_restricted' },
  });
  expect(f.services.policy.set).not.toHaveBeenCalled();
  f.services.policy.set.mockReturnValue({
    ok: false,
    error: { code: 'model_policy_revision_conflict', message: 'private' },
  });
  expect(await f.settings.dispatch('rooms.setModelPolicy', input, f.signal.signal)).toEqual({
    error: { code: 'model_policy_revision_conflict' },
  });
});

it('a drain deadline remains uncertain while a detached durable publication is still owned', async () => {
  const f = fixture();
  let settle!: (value: unknown) => void;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  f.services.connections.set.mockReturnValue(gate);
  const input = {
    connectionId: 'c',
    requestId: 'r',
    expectedRevision: null,
    providerId: 'deepseek',
    kind: 'cloud',
    endpoint: 'https://api.deepseek.com',
    auth: 'api_key',
    defaultModelId: 'deepseek-flash',
    key: 'fixture-key',
  };
  const job = f.settings.dispatch('modelConnections.set', input, f.signal.signal);
  f.signal.abort();
  await expect(assertRuntimeDrained([f.settings], 5)).rejects.toThrow('stop_incomplete');
  expect(await f.settings.dispatch('modelConnections.set', input, f.signal.signal)).toEqual({
    error: { code: 'runtime_draining' },
  });
  expect(f.services.connections.set).toHaveBeenCalledExactlyOnceWith(input);
  settle({ revision: 1 });
  expect(await job).toEqual({ result: { revision: 1 } });
  await expect(f.settings.drain()).resolves.toBe('settled');
});
