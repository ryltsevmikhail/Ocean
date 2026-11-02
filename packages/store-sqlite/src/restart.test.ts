import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import {
  TaskRunService,
  type Clock,
  type CommandReceipt,
  type IdGenerator,
} from '@runnets/application';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
} from '@runnets/domain';

import { openSqliteStore } from './index.js';

const TASK_RUN = taskRunId('tr_0001');
const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const CLOCK: Clock = { now: () => FIXED_NOW };
const ACTOR = { kind: 'user', id: 'user-1' } as const;

function fixedIds(): IdGenerator {
  let event = 0;
  let command = 0;
  return {
    eventId: () => `ev_test_${String(++event).padStart(4, '0')}`,
    commandId: () => `cm_test_${String(++command).padStart(4, '0')}`,
  };
}

function createRunCommand(): AnyCommand {
  return {
    type: 'CreateTaskRun',
    commandId: 'cm_0001',
    taskRunId: TASK_RUN,
    expectedVersion: 0,
    actor: ACTOR,
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

function admitCommand(): AnyCommand {
  return {
    type: 'Admit',
    commandId: 'cm_0002',
    taskRunId: TASK_RUN,
    expectedVersion: 1,
    actor: ACTOR,
    payload: {},
  };
}

function scheduleCommand(): AnyCommand {
  return {
    type: 'Schedule',
    commandId: 'cm_0003',
    taskRunId: TASK_RUN,
    expectedVersion: 2,
    actor: ACTOR,
    payload: {},
  };
}

function startAttemptCommand(): AnyCommand {
  return {
    type: 'StartAttempt',
    commandId: 'cm_0004',
    taskRunId: TASK_RUN,
    expectedVersion: 3,
    actor: ACTOR,
    payload: {
      attemptId: 'at_0001',
      reason: 'initial',
      provider: 'test-provider',
      model: 'model-a',
    },
  };
}

describe('durable store across restarts', () => {
  it('recovers events, receipts and checkpoints after reopening the database file', async () => {
    // Documented exception to the "no filesystem in tests" rule: a restart can
    // only be proved against a real database file, so this single test uses
    // mkdtemp and removes the temporary directory again in `finally`.
    const directory = await mkdtemp(join(tmpdir(), 'runnets-store-sqlite-'));
    const path = join(directory, 'store.sqlite');
    let createdReceipt: CommandReceipt | null = null;
    try {
      const first = openSqliteStore({ path });
      try {
        const service = new TaskRunService({
          log: first.log,
          dedup: first.dedup,
          ids: fixedIds(),
          clock: CLOCK,
        });
        const created = await service.execute(createRunCommand());
        if (!created.ok) throw new Error(`unexpected failure: ${created.error.message}`);
        createdReceipt = created.value;
        const queued = await service.execute(admitCommand());
        expect(queued.ok).toBe(true);

        await first.checkpoints.save(TASK_RUN, 2, await first.log.load(TASK_RUN));
        const admitted = await service.execute(scheduleCommand());
        expect(admitted.ok).toBe(true);
      } finally {
        first.close();
      }

      // WAL is a persistent property of the file, not of the connection.
      const raw = new DatabaseSync(path);
      try {
        expect(raw.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
      } finally {
        raw.close();
      }

      const reopened = openSqliteStore({ path });
      try {
        const events = await reopened.log.load(TASK_RUN);
        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
        expect(events.map((event) => event.type)).toEqual([
          'task_run.created',
          'task_run.queued',
          'task_run.admitted',
        ]);

        const receipt = await reopened.dedup.get('cm_0001');
        expect(receipt).toEqual(createdReceipt);

        const recovered = await reopened.recover(TASK_RUN);
        expect(recovered.state.status).toBe('admitted');
        expect(recovered.state.version).toBe(3);
        expect(recovered.checkpoint?.eventPosition).toBe(2);

        // Appending continues the durable id sequence after the restart.
        const service = new TaskRunService({
          log: reopened.log,
          dedup: reopened.dedup,
          ids: fixedIds(),
          clock: CLOCK,
        });
        const started = await service.execute(startAttemptCommand());
        expect(started.ok).toBe(true);
        const after = await reopened.log.load(TASK_RUN);
        expect(after.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
        expect(after[3]?.eventId).toBe('ev_0004');
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
