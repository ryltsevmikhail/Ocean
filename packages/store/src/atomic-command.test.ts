import { expect, it } from 'vitest';
import { TaskRunService } from '@runnets/application';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
} from '@runnets/domain';
import { InMemoryEventLog } from './in-memory-event-log.js';
import { SequentialIdGenerator } from './id-generator.js';

const command: AnyCommand = {
  type: 'CreateTaskRun',
  commandId: 'cm_atomic',
  taskRunId: taskRunId('tr_atomic'),
  expectedVersion: 0,
  actor: { kind: 'user', id: 'user' },
  payload: {
    conversationId: conversationId('cv_atomic'),
    workspaceId: workspaceId('ws_atomic'),
    parentTaskRunId: null,
    model: 'model',
    policyId: 'pl_atomic',
    budget: unlimitedBudget(),
  },
};
function setup() {
  const ids = new SequentialIdGenerator();
  const log = new InMemoryEventLog(ids);
  const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
  return { log, service: new TaskRunService({ log, clock, ids }), clock, ids };
}
it('returns one original receipt to concurrent identical commands', async () => {
  const { service, log } = setup();
  const results = await Promise.all([service.execute(command), service.execute(command)]);
  expect(results[0]?.ok).toBe(true);
  expect(results[1]).toEqual(results[0]);
  expect(await log.load(command.taskRunId)).toHaveLength(1);
});
it('keeps command receipts when the service is recreated', async () => {
  const { service, log, clock, ids } = setup();
  const first = await service.execute(command);
  expect(first.ok).toBe(true);
  expect(await new TaskRunService({ log, clock, ids }).execute(command)).toEqual(first);
});
it('rejects command identity reuse with another task, actor, version or payload', async () => {
  const { service, log } = setup();
  expect((await service.execute(command)).ok).toBe(true);
  const variants: AnyCommand[] = [
    { ...command, taskRunId: taskRunId('tr_other') },
    { ...command, actor: { kind: 'user', id: 'other' } },
    { ...command, expectedVersion: 1 },
    { ...command, payload: { ...command.payload, model: 'other' } },
  ];
  for (const variant of variants) expect((await service.execute(variant)).ok).toBe(false);
  expect(await log.load(taskRunId('tr_other'))).toHaveLength(0);
});

it('replays when another submission commits between lookup and stream load', async () => {
  const { service, log, clock, ids } = setup();
  const raced = new TaskRunService({
    log: {
      commands: log.commands,
      load: async (id) => {
        expect((await service.execute(command)).ok).toBe(true);
        return log.load(id);
      },
      append: (...args) => log.append(...args),
    },
    clock,
    ids,
  });
  const result = await raced.execute(command);
  expect(result.ok).toBe(true);
  expect(result).toEqual(await service.execute(command));
  expect(await log.load(command.taskRunId)).toHaveLength(1);
});
it('allows only one target when concurrent submissions reuse an identity', async () => {
  const { service, log } = setup();
  const other = { ...command, taskRunId: taskRunId('tr_other') };
  const results = await Promise.all([service.execute(command), service.execute(other)]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  const count =
    (await log.load(command.taskRunId)).length + (await log.load(other.taskRunId)).length;
  expect(count).toBe(1);
});

it('returns committed receipts even if an optional legacy mirror fails', async () => {
  const { log, clock, ids } = setup();
  const service = new TaskRunService({
    log,
    clock,
    ids,
    dedup: {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('mirror unavailable')),
    },
  });
  const result = await service.execute(command);
  expect(result.ok).toBe(true);
  expect(await service.execute(command)).toEqual(result);
  expect(await log.load(command.taskRunId)).toHaveLength(1);
});

it('binds the decision to a request snapshot taken before asynchronous work', async () => {
  const { log, clock, ids } = setup();
  let release: () => void = () => {
    throw new Error('load not started');
  };
  let started: () => void = () => {
    throw new Error('signal not initialized');
  };
  const loaded = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new TaskRunService({
    log: {
      commands: log.commands,
      load: async (id) => {
        started();
        await waiting;
        return log.load(id);
      },
      append: (...args) => log.append(...args),
    },
    clock,
    ids,
  });
  const submitted = { ...command, payload: { ...command.payload } };
  const pending = service.execute(submitted);
  await loaded;
  submitted.payload.model = 'mutated';
  release();
  const result = await pending;
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.events[0]?.payload).toMatchObject({ model: 'model' });
  expect(await service.execute(command)).toEqual(result);
  expect((await service.execute(submitted)).ok).toBe(false);
});
