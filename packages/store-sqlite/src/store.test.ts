import { afterEach, describe, expect, it } from 'vitest';

import { TaskRunService, type Clock, type IdGenerator } from '@runnets/application';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
} from '@runnets/domain';

import { openSqliteStore, type SqliteStore } from './index.js';

const TASK_RUN = taskRunId('tr_0001');
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const CLOCK: Clock = { now: () => FIXED_NOW };

const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

function openMemoryStore(): SqliteStore {
  const store = openSqliteStore({ path: ':memory:' });
  stores.push(store);
  return store;
}

function fixedIds(): IdGenerator {
  let event = 0;
  let command = 0;
  return {
    eventId: () => `ev_test_${String(++event).padStart(4, '0')}`,
    commandId: () => `cm_test_${String(++command).padStart(4, '0')}`,
  };
}

function createCommand(): AnyCommand {
  return {
    type: 'CreateTaskRun',
    commandId: 'cm_test_0001',
    taskRunId: TASK_RUN,
    expectedVersion: 0,
    actor: { kind: 'user', id: 'user-1' },
    payload: {
      conversationId: conversationId('cv_0001'),
      workspaceId: workspaceId('ws_0001'),
      parentTaskRunId: null,
      model: 'model-a',
      policyId: 'pl_0001',
      budget: unlimitedBudget(),
    },
  };
}

describe('openSqliteStore', () => {
  it('exposes a working log and checkpoint store over :memory:', async () => {
    const store = openMemoryStore();

    const outcome = await store.log.append(TASK_RUN, 0, [], {
      correlationId: 'tr_0001',
      timestamp: FIXED_NOW.toISOString(),
      actorId: 'rt_0001',
    });
    expect(outcome.ok).toBe(true);
    await expect(store.log.load(TASK_RUN)).resolves.toEqual([]);
    await expect(store.checkpoints.latest(TASK_RUN)).resolves.toBeNull();
    await expect(store.dedup.get('cm_missing')).resolves.toBeNull();
  });

  it('closes the connection once and rejects work afterwards', async () => {
    const store = openMemoryStore();
    store.close();
    store.close();

    await expect(store.log.load(TASK_RUN)).rejects.toThrow();
  });

  it('replays a command receipt instead of appending twice', async () => {
    const store = openMemoryStore();
    const service = new TaskRunService({
      log: store.log,
      dedup: store.dedup,
      ids: fixedIds(),
      clock: CLOCK,
    });
    const command = createCommand();

    const first = await service.execute(command);
    if (!first.ok) throw new Error(`unexpected failure: ${first.error.message}`);
    const second = await service.execute(command);

    expect(second).toEqual(first);
    expect(first.value.version).toBe(1);
    expect(first.value.events).toHaveLength(1);
    await expect(store.dedup.get(command.commandId)).resolves.toEqual(first.value);
    await expect(store.log.load(TASK_RUN)).resolves.toHaveLength(1);

    const stale = await service.execute({ ...command, commandId: 'cm_test_0002' });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('expected a version conflict');
    expect(stale.error.code).toBe('version_conflict');
  });

  it('recovers state through the public factory', async () => {
    const store = openMemoryStore();
    const service = new TaskRunService({
      log: store.log,
      dedup: store.dedup,
      ids: fixedIds(),
      clock: CLOCK,
    });
    const first = await service.execute(createCommand());
    if (!first.ok) throw new Error(`unexpected failure: ${first.error.message}`);
    const events = await store.log.load(TASK_RUN);
    await store.checkpoints.save(TASK_RUN, 1, events);

    const recovered = await store.recover(TASK_RUN);

    expect(recovered.state.status).toBe('created');
    expect(recovered.state.version).toBe(1);
    expect(recovered.checkpoint?.eventPosition).toBe(1);
  });
});
