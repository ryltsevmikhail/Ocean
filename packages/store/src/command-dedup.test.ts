import { describe, expect, it } from 'vitest';

import { TaskRunService, type Clock, type CommandReceipt } from '@runnets/application';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
  type TaskRunEvent,
} from '@runnets/domain';

import { InMemoryCommandDedup } from './command-dedup.js';
import { InMemoryEventLog } from './in-memory-event-log.js';
import { SequentialIdGenerator } from './id-generator.js';

const COMMAND_ID = 'cm_0001';
const TASK_RUN_ID = taskRunId('tr_0001');

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const clock: Clock = { now: () => FIXED_NOW };

function receipt(version: number, events: readonly TaskRunEvent[] = []): CommandReceipt {
  return { commandId: COMMAND_ID, taskRunId: TASK_RUN_ID, version, events };
}

function createCommand(): AnyCommand {
  return {
    type: 'CreateTaskRun',
    commandId: COMMAND_ID,
    taskRunId: TASK_RUN_ID,
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

describe('InMemoryCommandDedup', () => {
  it('returns null for a command that has not committed', async () => {
    const dedup = new InMemoryCommandDedup();
    await expect(dedup.get(COMMAND_ID)).resolves.toBeNull();
  });

  it('replays the committed receipt for a duplicate command id', async () => {
    const dedup = new InMemoryCommandDedup();
    const committed = receipt(2);
    await dedup.put(committed);

    await expect(dedup.get(COMMAND_ID)).resolves.toEqual(committed);
  });

  it('keeps the first receipt when the same command id is stored twice', async () => {
    const dedup = new InMemoryCommandDedup();
    await dedup.put(receipt(1));
    await dedup.put(receipt(9));

    const stored = await dedup.get(COMMAND_ID);
    expect(stored?.version).toBe(1);
  });

  it('returns a frozen event list detached from the submitted receipt', async () => {
    const dedup = new InMemoryCommandDedup();
    const events: readonly TaskRunEvent[] = [];
    await dedup.put({ ...receipt(1), events });

    const stored = await dedup.get(COMMAND_ID);
    if (stored === null) throw new Error('expected a stored receipt');
    expect(Object.isFrozen(stored.events)).toBe(true);
    expect(stored.events).not.toBe(events);
  });
});

describe('idempotent command submission', () => {
  it('replays the original receipt instead of appending the command twice', async () => {
    const ids = new SequentialIdGenerator();
    const log = new InMemoryEventLog(ids);
    const dedup = new InMemoryCommandDedup();
    const service = new TaskRunService({ log, clock, ids, dedup });
    const command = createCommand();

    const first = await service.execute(command);
    if (!first.ok) throw new Error(`unexpected failure: ${first.error.message}`);
    const second = await service.execute(command);

    expect(second).toEqual(first);
    expect(first.value.version).toBe(1);
    expect(first.value.events).toHaveLength(1);
    await expect(dedup.get(COMMAND_ID)).resolves.toEqual(first.value);
    await expect(log.load(TASK_RUN_ID)).resolves.toHaveLength(1);
  });
});
