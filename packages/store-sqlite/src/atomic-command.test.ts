import { expect, it } from 'vitest';
import { TaskRunService } from '@runnets/application';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
} from '@runnets/domain';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEventLog } from './event-log.js';
import { initializeSchema } from './schema.js';
import { SqliteCommandDedup } from './command-dedup.js';
import { createDurableIdGenerator } from './id-source.js';

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
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  const ids = createDurableIdGenerator(db);
  const log = new SqliteEventLog(db, ids);
  const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
  return { db, log, service: new TaskRunService({ log, clock, ids }), clock, ids };
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

it('rolls back events if the atomic receipt insert fails', async () => {
  const { db, log, service } = setup();
  db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON command_receipts
    BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`);
  await expect(service.execute(command)).rejects.toThrow('receipt rejected');
  expect(await log.load(command.taskRunId)).toHaveLength(0);
  expect(await new SqliteCommandDedup(db).get(command.commandId)).toBeNull();
  db.exec('DROP TRIGGER reject_receipt');
  expect((await service.execute(command)).ok).toBe(true);
});
it('upgrades legacy v1 receipt storage and rejects unverifiable retries', async () => {
  const { db, log, service } = setup();
  db.exec('ALTER TABLE command_receipts DROP COLUMN request_binding');
  initializeSchema(db);
  await new SqliteCommandDedup(db).put({
    commandId: command.commandId,
    taskRunId: command.taskRunId,
    version: 0,
    events: [],
  });
  expect((await service.execute(command)).ok).toBe(false);
  expect(await log.load(command.taskRunId)).toHaveLength(0);
});
it('preserves the bound receipt across new adapter and service instances', async () => {
  const { db, service, clock, ids } = setup();
  const original = await service.execute(command);
  expect(original.ok).toBe(true);
  const restarted = new TaskRunService({ log: new SqliteEventLog(db, ids), clock, ids });
  expect(await restarted.execute(command)).toEqual(original);
});
it('allocates independent default ids across generator instances', () => {
  const { db } = setup();
  const first = createDurableIdGenerator(db);
  const second = createDurableIdGenerator(db);
  expect(first.commandId()).not.toBe(second.commandId());
  expect(first.eventId()).not.toBe(second.eventId());
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

it('skips persisted identities from injected generators when default adapters resume', async () => {
  const { db, clock } = setup();
  const injected = { eventId: () => 'ev_0002', commandId: () => 'cm_0002' };
  const imported = new TaskRunService({
    log: new SqliteEventLog(db, injected),
    clock,
    ids: injected,
  });
  expect((await imported.execute({ ...command, commandId: 'cm_0002' })).ok).toBe(true);
  const ids = createDurableIdGenerator(db);
  const log = new SqliteEventLog(db, ids);
  const resumed = new TaskRunService({ log, clock, ids });
  const commandId = resumed.nextCommandId();
  expect(commandId).not.toBe('cm_0002');
  const result = await resumed.execute({
    ...command,
    commandId,
    taskRunId: taskRunId('tr_resumed'),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.events[0]?.eventId).not.toBe('ev_0002');
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
it('rejects a different cancellation binding before decoding the original command’s event data', async () => {
  const { db, service } = setup();
  const created = await service.execute(command);
  expect(created.ok).toBe(true);
  const cancel: AnyCommand = {
    commandId: 'room-cancel-same',
    taskRunId: command.taskRunId,
    expectedVersion: 1,
    type: 'RequestCancel',
    actor: { kind: 'user', id: 'owner' },
    payload: { cause: 'room one' },
  };
  expect((await service.execute(cancel)).ok).toBe(true);
  db.prepare(
    "UPDATE command_receipts SET events='private undecodable event' WHERE command_id=?",
  ).run(cancel.commandId);
  await expect(
    service.lookupCommand({ ...cancel, payload: { cause: 'room two' } }),
  ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
});
it('settles a cancelling active attempt once and keeps an actual budget overrun terminal without claiming cleanup', async () => {
  const { db, service, log } = setup();
  const run = async (
    type: AnyCommand['type'],
    version: number,
    payload: unknown,
    id = String(version),
  ) =>
    service.execute({
      type,
      taskRunId: command.taskRunId,
      commandId: id,
      actor: command.actor,
      expectedVersion: version,
      payload,
    } as AnyCommand);
  try {
    expect(
      (
        await service.execute({
          ...command,
          payload: { ...command.payload, budget: { ...unlimitedBudget(), provider_tokens: 2 } },
        })
      ).ok,
    ).toBe(true);
    expect((await run('Admit', 1, {})).ok).toBe(true);
    expect((await run('Schedule', 2, {})).ok).toBe(true);
    expect(
      (
        await run('StartAttempt', 3, {
          attemptId: 'a',
          reason: 'initial',
          model: 'fake',
          provider: 'test',
        })
      ).ok,
    ).toBe(true);
    expect((await run('RequestCancel', 4, { cause: 'owner requested' })).ok).toBe(true);
    const usage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 };
    expect(await run('RecordUsage', 5, { attemptId: 'foreign', usage }, 'wrong')).toMatchObject({
      ok: false,
      error: { code: 'invariant_violation' },
    });
    const settle = () => run('RecordUsage', 5, { attemptId: 'a', usage });
    const settled = await settle();
    expect(settled).toMatchObject({ ok: true, value: { version: 7 } });
    expect(await settle()).toEqual(settled);
    expect(await service.state(command.taskRunId)).toMatchObject({
      version: 7,
      status: 'budget_exhausted',
      cancellationCause: 'owner requested',
      budget: { consumed: { provider_tokens: 3 } },
    });
    expect((await log.load(command.taskRunId)).slice(4).map((e) => e.type)).toEqual([
      'task_run.cancelling',
      'attempt.usage_recorded',
      'task_run.budget_exhausted',
    ]);
    expect(await run('CompleteCleanup', 7, { cleanup: 'completed' })).toMatchObject({
      ok: false,
      error: { code: 'terminal_state' },
    });
  } finally {
    db.close();
  }
});
