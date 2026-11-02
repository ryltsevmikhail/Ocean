import { expect, it } from 'vitest';
import { ToolService, type ToolExecutorPort, type ToolPermissionPort } from './tools.js';

it('never executes a rejected edit and returns a correlated error', async () => {
  let executed = 0;
  const executor: ToolExecutorPort = {
    definitions: [],
    prepare: () =>
      Promise.resolve({
        title: 'edit a.ts',
        kind: 'edit',
        preview: 'before -> after',
        execute: () => {
          executed++;
          return Promise.resolve({ output: 'done', isError: false });
        },
      }),
  };
  const permissions: ToolPermissionPort = { review: () => Promise.resolve('reject') };
  const service = new ToolService(executor, permissions);
  const result = await service.execute(
    { id: 'a', name: 'write_file', arguments: '{}' },
    new AbortController().signal,
  );
  expect(executed).toBe(0);
  expect(result.isError).toBe(true);
  expect(result.output).toContain('denied');
});

it('claims an invocation before execution and does not repeat an uncertain effect', async () => {
  let executed = 0;
  const executor: ToolExecutorPort = {
    definitions: [],
    prepare: () =>
      Promise.resolve({
        title: 'command',
        kind: 'execute',
        preview: 'test',
        execute: () => {
          executed++;
          return Promise.reject(new Error('lost response'));
        },
      }),
  };
  const service = new ToolService(executor, { review: () => Promise.resolve('allow_once') });
  const call = { id: 'a', name: 'run_command', arguments: '{}' };
  const first = await service.execute(call, new AbortController().signal);
  const second = await service.execute(call, new AbortController().signal);
  expect(first.isError).toBe(true);
  expect(second).toEqual(first);
  expect(executed).toBe(1);
});

it('checks cancellation after approval and before dispatch', async () => {
  const controller = new AbortController();
  let executed = false;
  const executor: ToolExecutorPort = {
    definitions: [],
    prepare: () =>
      Promise.resolve({
        title: 'edit',
        kind: 'edit',
        preview: 'diff',
        execute: () => {
          executed = true;
          return Promise.resolve({ output: 'ok', isError: false });
        },
      }),
  };
  const service = new ToolService(executor, {
    review: () => {
      controller.abort();
      return Promise.resolve('allow_once');
    },
  });
  expect(
    (await service.execute({ id: 'a', name: 'write_file', arguments: '{}' }, controller.signal))
      .isError,
  ).toBe(true);
  expect(executed).toBe(false);
});

it('scopes session approval to the exact prepared operation', async () => {
  let reviews = 0;
  let effects = 0;
  const service = new ToolService(
    {
      definitions: [],
      prepare: (call) =>
        Promise.resolve({
          title: call.name,
          kind: 'execute',
          preview: call.arguments,
          execute: () => {
            effects++;
            return Promise.resolve({ output: 'ok', isError: false });
          },
        }),
    },
    {
      review: (tool) => {
        expect(Object.isFrozen(tool)).toBe(true);
        expect(tool).not.toHaveProperty('execute');
        reviews++;
        return Promise.resolve('allow_session');
      },
    },
  );
  const signal = new AbortController().signal;
  await service.execute({ id: 'a', name: 'run', arguments: 'one' }, signal);
  await service.execute({ id: 'b', name: 'run', arguments: 'two' }, signal);
  expect(effects).toBe(2);
  expect(reviews).toBe(2);
});

it('does not dispatch without durable context or when its durable claim fails', async () => {
  let effects = 0;
  const journal = {
    claim: () => Promise.reject(new Error('unavailable')),
    settle: () => Promise.resolve(),
    pending: () => Promise.resolve([]),
    recover: () => Promise.resolve(),
  };
  const service = new ToolService(
    {
      definitions: [],
      prepare: () =>
        Promise.resolve({
          title: 'edit',
          kind: 'edit',
          preview: 'diff',
          execute: () => {
            effects++;
            return Promise.resolve({ output: 'ok', isError: false });
          },
        }),
    },
    { review: () => Promise.resolve('allow_once') },
    journal,
  );
  const call = { id: 'call', name: 'edit', arguments: '{}' };
  expect((await service.execute(call, new AbortController().signal)).isError).toBe(true);
  expect(
    (
      await service.execute(call, new AbortController().signal, {
        taskRunId: 'tr',
        attemptId: 'at',
      })
    ).isError,
  ).toBe(true);
  expect(effects).toBe(0);
});

it('waits for execution and retains uncertainty when recording its outcome fails', async () => {
  let finish: ((value: { output: string; isError: boolean }) => void) | undefined;
  let effects = 0;
  const service = new ToolService(
    {
      definitions: [],
      prepare: () =>
        Promise.resolve({
          title: 'edit',
          kind: 'edit',
          preview: 'diff',
          execute: () => {
            effects++;
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        }),
    },
    { review: () => Promise.resolve('allow_once') },
    {
      claim: () => Promise.resolve(true),
      settle: () => Promise.reject(new Error('disk unavailable')),
      pending: () => Promise.resolve([]),
      recover: () => Promise.resolve(),
    },
  );
  const controller = new AbortController();
  const call = { id: 'a', name: 'edit', arguments: '{}' };
  const context = { taskRunId: 'tr', attemptId: 'at' };
  const pending = service.execute(call, controller.signal, context);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(effects).toBe(1);
  controller.abort();
  if (finish === undefined) throw new Error('executor was not started');
  finish({ output: 'effect completed', isError: false });
  const result = await pending;
  expect(result.uncertain).toBe(true);
  expect(await service.execute(call, controller.signal, context)).toEqual(result);
  expect(effects).toBe(1);
});

it('blocks fresh invocations before preparation when any durable effect is unresolved', async () => {
  let preparations = 0;
  const service = new ToolService(
    {
      definitions: [],
      prepare: () => {
        preparations++;
        return Promise.reject(new Error('must not prepare'));
      },
    },
    { review: () => Promise.resolve('allow_once') },
    {
      claim: () => Promise.resolve(true),
      settle: () => Promise.resolve(),
      recover: () => Promise.resolve(),
      pending: () =>
        Promise.resolve([
          {
            id: 'old',
            tool: 'edit',
            taskRunId: '',
            attemptId: '',
            fingerprint: '',
            outcome: 'started',
          },
        ]),
    },
  );
  expect(
    await service.execute(
      { id: 'new', name: 'edit', arguments: '{}' },
      new AbortController().signal,
      { taskRunId: 'fresh', attemptId: 'fresh' },
    ),
  ).toMatchObject({ isError: true, uncertain: true });
  expect(preparations).toBe(0);
});

it('retains uncertainty if cancellation after claiming cannot be durably recorded as not started', async () => {
  const controller = new AbortController();
  let effects = 0;
  const service = new ToolService(
    {
      definitions: [],
      prepare: () =>
        Promise.resolve({
          title: 'edit',
          kind: 'edit',
          preview: 'diff',
          execute: () => {
            effects++;
            return Promise.resolve({ output: 'unexpected', isError: false });
          },
        }),
    },
    { review: () => Promise.resolve('allow_once') },
    {
      pending: () => Promise.resolve([]),
      recover: () => Promise.resolve(),
      claim: () => {
        controller.abort();
        return Promise.resolve(true);
      },
      settle: () => Promise.reject(new Error('disk unavailable')),
    },
  );
  expect(
    await service.execute({ id: 'a', name: 'edit', arguments: '{}' }, controller.signal, {
      taskRunId: 'tr',
      attemptId: 'at',
    }),
  ).toMatchObject({ isError: true, uncertain: true });
  expect(effects).toBe(0);
});

it('latches uncertainty across fresh identities even without an external journal', async () => {
  let effects = 0;
  const service = new ToolService(
    {
      definitions: [],
      prepare: () =>
        Promise.resolve({
          title: 'edit',
          kind: 'edit',
          preview: 'diff',
          execute: () => {
            effects++;
            return Promise.resolve({ output: 'unknown', isError: true, uncertain: true });
          },
        }),
    },
    { review: () => Promise.resolve('allow_once') },
  );
  const signal = new AbortController().signal;
  expect(
    (await service.execute({ id: 'old', name: 'edit', arguments: '{}' }, signal)).uncertain,
  ).toBe(true);
  expect(
    (await service.execute({ id: 'fresh', name: 'edit', arguments: '{}' }, signal)).uncertain,
  ).toBe(true);
  expect(effects).toBe(1);
});
