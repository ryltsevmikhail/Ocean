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
  type EventEnvelope,
  type TaskRunEventDraft,
} from '@runnets/domain';

import { SqliteCheckpointStore } from './checkpoints.js';
import { SqliteEventLog } from './event-log.js';
import { createDurableIdGenerator } from './id-source.js';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';

const TASK_RUN = taskRunId('tr_0001');
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

interface Harness {
  readonly db: DatabaseSync;
  readonly log: SqliteEventLog;
  readonly checkpoints: SqliteCheckpointStore;
}

function createHarness(): Harness {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  const log = new SqliteEventLog(db, createDurableIdGenerator(db));
  return { db, log, checkpoints: new SqliteCheckpointStore(db, log) };
}

async function appendThreeEvents(log: SqliteEventLog): Promise<readonly EventEnvelope[]> {
  await log.append(TASK_RUN, 0, [createdDraft()], META);
  await log.append(TASK_RUN, 1, [queuedDraft()], META);
  await log.append(TASK_RUN, 2, [admittedDraft()], META);
  return log.load(TASK_RUN);
}

function eventAt(events: readonly EventEnvelope[], index: number): EventEnvelope {
  const event = events[index];
  if (event === undefined) throw new Error(`event ${index} is missing from the stream`);
  return event;
}

describe('SqliteCheckpointStore', () => {
  it('reports no checkpoint before one is saved', async () => {
    const { checkpoints } = createHarness();

    await expect(checkpoints.latest(TASK_RUN)).resolves.toBeNull();
  });

  it('rejects positions outside the committed stream', async () => {
    const { log, checkpoints } = createHarness();
    await appendThreeEvents(log);

    await expect(checkpoints.save(TASK_RUN, 0)).rejects.toThrow(RangeError);
    await expect(checkpoints.save(TASK_RUN, -1)).rejects.toThrow(RangeError);
    await expect(checkpoints.save(TASK_RUN, 1.5)).rejects.toThrow(RangeError);
    await expect(checkpoints.save(TASK_RUN, 4)).rejects.toThrow(/past the committed version/);
    await expect(checkpoints.latest(TASK_RUN)).resolves.toBeNull();
  });

  it('records a validated position with its snapshot and exposes later events', async () => {
    const { log, checkpoints } = createHarness();
    const events = await appendThreeEvents(log);

    const saved = await checkpoints.save(TASK_RUN, 2, events.slice(0, 2));

    expect(saved.eventPosition).toBe(2);
    expect(saved.taskRunId).toBe(TASK_RUN);
    expect(saved.schemaVersion).toBe(1);
    expect(saved.snapshot?.map((event) => event.sequence)).toEqual([1, 2]);

    const latest = await checkpoints.latest(TASK_RUN);
    expect(latest).toEqual(saved);

    const after = await checkpoints.loadAfter(TASK_RUN, 2);
    expect(after.map((event) => event.sequence)).toEqual([3]);
    await expect(checkpoints.loadAfter(TASK_RUN, 0)).resolves.toHaveLength(3);
    await expect(checkpoints.loadAfter(TASK_RUN, 3)).resolves.toEqual([]);
  });

  it('stores a checkpoint without a snapshot', async () => {
    const { log, checkpoints } = createHarness();
    await appendThreeEvents(log);

    const saved = await checkpoints.save(TASK_RUN, 1);

    expect(saved.snapshot).toBeNull();
    await expect(checkpoints.latest(TASK_RUN)).resolves.toEqual(saved);
  });

  it('keeps the first checkpoint stored at a position', async () => {
    const { db, log, checkpoints } = createHarness();
    const events = await appendThreeEvents(log);

    await checkpoints.save(TASK_RUN, 2, events.slice(0, 2));
    await checkpoints.save(TASK_RUN, 2, events.slice(0, 2));

    const count = db
      .prepare('SELECT COUNT(*) AS count FROM checkpoints WHERE aggregate_id = ?')
      .get(TASK_RUN);
    expect(count?.['count']).toBe(1);
  });

  it('rejects a snapshot that is not the committed prefix', async () => {
    const { log, checkpoints } = createHarness();
    const events = await appendThreeEvents(log);

    await expect(checkpoints.save(TASK_RUN, 2, events.slice(0, 1))).rejects.toThrow(
      /must cover sequences 1\.\.2/,
    );

    const mismatched = [eventAt(events, 0), { ...eventAt(events, 1), eventId: 'ev_9999' }];
    await expect(checkpoints.save(TASK_RUN, 2, mismatched)).rejects.toThrow(
      /does not match the committed event log/,
    );
    await expect(checkpoints.latest(TASK_RUN)).resolves.toBeNull();
  });

  it('rejects a snapshot whose aggregate or sequence does not line up', async () => {
    const { log, checkpoints } = createHarness();
    const events = await appendThreeEvents(log);

    const foreign = [
      { ...eventAt(events, 0), aggregateId: taskRunId('tr_0002') },
      eventAt(events, 1),
    ];
    await expect(checkpoints.save(TASK_RUN, 2, foreign)).rejects.toThrow(/belongs to/);

    const reordered = [eventAt(events, 1), eventAt(events, 0)];
    await expect(checkpoints.save(TASK_RUN, 2, reordered)).rejects.toThrow(/carries sequence/);
  });

  it('fails closed when a stored checkpoint names an unsupported schema version', async () => {
    const { db, log, checkpoints } = createHarness();
    await appendThreeEvents(log);
    await checkpoints.save(TASK_RUN, 1);
    db.prepare('UPDATE checkpoints SET schema_version = 2').run();

    await expect(checkpoints.latest(TASK_RUN)).rejects.toThrow(/is not supported/);
  });

  it('fails closed when a stored snapshot is corrupt', async () => {
    const { db, log, checkpoints } = createHarness();
    await appendThreeEvents(log);
    await checkpoints.save(TASK_RUN, 1);
    db.prepare('UPDATE checkpoints SET snapshot = ?').run('not-json');

    await expect(checkpoints.latest(TASK_RUN)).rejects.toThrow(/not valid JSON/);
  });
});
