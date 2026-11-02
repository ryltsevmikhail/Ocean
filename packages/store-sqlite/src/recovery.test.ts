import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppendMeta } from '@runnets/application';
import {
  conversationId,
  draft,
  policyId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type Actor,
  type TaskRunEventDraft,
} from '@runnets/domain';

import { SqliteCheckpointStore } from './checkpoints.js';
import { SqliteEventLog } from './event-log.js';
import { createDurableIdGenerator } from './id-source.js';
import { createRecovery, type RecoveryPort } from './recovery.js';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';

const TASK_RUN = taskRunId('tr_0001');
const UNKNOWN_RUN = taskRunId('tr_0002');
const ACTOR: Actor = { kind: 'runtime', id: 'rt_draft' };

const META: AppendMeta = {
  correlationId: 'tr_0001',
  timestamp: '2026-01-01T00:00:00.000Z',
  actorId: 'rt_meta',
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases) {
    if (db.isOpen) db.close();
  }
  databases.length = 0;
});

function createdDraft(): TaskRunEventDraft {
  return draft(
    'task_run.created',
    {
      conversationId: conversationId('cv_0001'),
      workspaceId: workspaceId('ws_0001'),
      parentTaskRunId: null,
      model: 'model-a',
      policyId: policyId('pl_0001'),
      budget: unlimitedBudget(),
    },
    { actor: ACTOR },
  );
}

function queuedDraft(): TaskRunEventDraft {
  return draft('task_run.queued', {}, { actor: ACTOR });
}

function admittedDraft(): TaskRunEventDraft {
  return draft('task_run.admitted', {}, { actor: ACTOR });
}

function startedDraft(): TaskRunEventDraft {
  return draft(
    'attempt.started',
    { attemptId: 'at_0001', ordinal: 1, reason: 'initial', provider: 'test', model: 'model-a' },
    { actor: ACTOR },
  );
}

interface Harness {
  readonly db: DatabaseSync;
  readonly log: SqliteEventLog;
  readonly checkpoints: SqliteCheckpointStore;
  readonly recovery: RecoveryPort;
}

function createHarness(): Harness {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  const log = new SqliteEventLog(db, createDurableIdGenerator(db));
  const checkpoints = new SqliteCheckpointStore(db, log);
  return { db, log, checkpoints, recovery: createRecovery(log, checkpoints) };
}

async function appendTwoEvents(log: SqliteEventLog): Promise<void> {
  await log.append(TASK_RUN, 0, [createdDraft()], META);
  await log.append(TASK_RUN, 1, [queuedDraft()], META);
}

describe('createRecovery', () => {
  it('reports an absent aggregate when the stream is empty', async () => {
    const { recovery } = createHarness();

    const result = await recovery.recover(UNKNOWN_RUN);

    expect(result.checkpoint).toBeNull();
    expect(result.state.status).toBe('absent');
    expect(result.state.version).toBe(0);
  });

  it('replays the whole stream when no checkpoint exists', async () => {
    const { log, recovery } = createHarness();
    await appendTwoEvents(log);

    const result = await recovery.recover(TASK_RUN);

    expect(result.checkpoint).toBeNull();
    expect(result.state.status).toBe('queued');
    expect(result.state.version).toBe(2);
  });

  it('folds the checkpoint snapshot plus the events committed after it', async () => {
    const { log, checkpoints, recovery } = createHarness();
    await appendTwoEvents(log);
    await checkpoints.save(TASK_RUN, 2, await log.load(TASK_RUN));
    await log.append(TASK_RUN, 2, [admittedDraft(), startedDraft()], META);

    const result = await recovery.recover(TASK_RUN);

    expect(result.checkpoint?.eventPosition).toBe(2);
    expect(result.state.status).toBe('running');
    expect(result.state.version).toBe(4);
  });

  it('replays from scratch when the checkpoint carries no snapshot', async () => {
    const { log, checkpoints, recovery } = createHarness();
    await appendTwoEvents(log);
    await checkpoints.save(TASK_RUN, 1);
    await log.append(TASK_RUN, 2, [admittedDraft()], META);

    const result = await recovery.recover(TASK_RUN);

    expect(result.checkpoint?.eventPosition).toBe(1);
    expect(result.checkpoint?.snapshot).toBeNull();
    expect(result.state.status).toBe('admitted');
    expect(result.state.version).toBe(3);
  });

  it('fails closed when the checkpoint position is past the committed log', async () => {
    const { db, log, checkpoints, recovery } = createHarness();
    await appendTwoEvents(log);
    await checkpoints.save(TASK_RUN, 2, await log.load(TASK_RUN));
    // Simulate external corruption: the event log cannot shrink, so a position
    // beyond it can only come from a damaged checkpoint table.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      'UPDATE checkpoints SET event_position = 5, snapshot = NULL WHERE aggregate_id = ?',
    ).run(TASK_RUN);
    db.exec('PRAGMA foreign_keys = ON');

    await expect(recovery.recover(TASK_RUN)).rejects.toThrow(/past the committed version/);
  });

  it('fails closed when the snapshot no longer ends at the committed event', async () => {
    const { db, log, checkpoints, recovery } = createHarness();
    await appendTwoEvents(log);
    await checkpoints.save(TASK_RUN, 2, await log.load(TASK_RUN));
    db.prepare(
      `UPDATE checkpoints SET snapshot = REPLACE(snapshot, '"event_id":"ev_0002"', '"event_id":"ev_9999"')`,
    ).run();

    await expect(recovery.recover(TASK_RUN)).rejects.toThrow(
      /does not end at committed position 2/,
    );
  });
});
