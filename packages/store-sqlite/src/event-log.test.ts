import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppendMeta, IdGenerator } from '@runnets/application';
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

import { SqliteEventLog } from './event-log.js';
import { createDurableIdGenerator } from './id-source.js';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';

const TASK_RUN = taskRunId('tr_0001');
const OTHER_RUN = taskRunId('tr_0002');
const ACTOR: Actor = { kind: 'runtime', id: 'rt_draft' };

const META: AppendMeta = {
  correlationId: 'tr_0001',
  timestamp: '2026-01-01T00:00:00.000Z',
  actorId: 'rt_meta',
};

const CREATE_PAYLOAD = {
  conversationId: conversationId('cv_0001'),
  workspaceId: workspaceId('ws_0001'),
  parentTaskRunId: null,
  model: 'model-a',
  policyId: policyId('pl_0001'),
  budget: unlimitedBudget(),
} as const;

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases) {
    if (db.isOpen) db.close();
  }
  databases.length = 0;
});

function createLog(ids?: IdGenerator): { db: DatabaseSync; log: SqliteEventLog } {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  return { db, log: new SqliteEventLog(db, ids ?? createDurableIdGenerator(db)) };
}

function createdDraft(): TaskRunEventDraft {
  return draft('task_run.created', CREATE_PAYLOAD, { actor: ACTOR });
}

function queuedDraft(): TaskRunEventDraft {
  return draft('task_run.queued', {}, { actor: ACTOR });
}

function admittedDraft(): TaskRunEventDraft {
  return draft('task_run.admitted', {}, { actor: ACTOR });
}

function eventAt(events: readonly EventEnvelope[], index: number): EventEnvelope {
  const event = events[index];
  if (event === undefined) throw new Error(`event ${index} is missing from the stream`);
  return event;
}

describe('SqliteEventLog', () => {
  it('assigns contiguous per-aggregate sequences and round-trips envelopes', async () => {
    const { log } = createLog();

    const first = await log.append(TASK_RUN, 0, [createdDraft()], META);
    const second = await log.append(TASK_RUN, 1, [queuedDraft(), admittedDraft()], META);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const events = await log.load(TASK_RUN);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual([
      'task_run.created',
      'task_run.queued',
      'task_run.admitted',
    ]);
    expect(events.map((event) => event.eventId)).toEqual(['ev_0001', 'ev_0002', 'ev_0003']);

    const created = eventAt(events, 0);
    expect(created.aggregateId).toBe(TASK_RUN);
    expect(created.aggregateType).toBe('task_run');
    expect(created.correlationId).toBe('tr_0001');
    expect(created.causationId).toBeNull();
    expect(created.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(created.schemaVersion).toBe(1);
    expect(created.sensitivity).toBe('internal');
    // Actor rule: kind from the draft, id from AppendMeta.actorId.
    expect(created.actor).toEqual({ kind: 'runtime', id: 'rt_meta' });
    expect(created.payload).toEqual(CREATE_PAYLOAD);
  });

  it('returns an empty stream for an unknown aggregate', async () => {
    const { log } = createLog();

    await expect(log.load(TASK_RUN)).resolves.toEqual([]);
  });

  it('rejects a stale expected version without appending', async () => {
    const { log } = createLog();
    await log.append(TASK_RUN, 0, [createdDraft()], META);

    const outcome = await log.append(TASK_RUN, 0, [queuedDraft()], META);

    expect(outcome).toEqual({ ok: false, actualVersion: 1 });
    await expect(log.load(TASK_RUN)).resolves.toHaveLength(1);
  });

  it('reports the actual version when the expected version is ahead', async () => {
    const { log } = createLog();

    const outcome = await log.append(TASK_RUN, 3, [createdDraft()], META);

    expect(outcome).toEqual({ ok: false, actualVersion: 0 });
    await expect(log.load(TASK_RUN)).resolves.toEqual([]);
  });

  it('commits a failing batch all-or-nothing', async () => {
    const { log } = createLog();
    const unserializable = {
      ...admittedDraft(),
      payload: { bad: 1n },
    } as unknown as TaskRunEventDraft;

    await expect(log.append(TASK_RUN, 0, [createdDraft(), unserializable], META)).rejects.toThrow(
      TypeError,
    );
    await expect(log.load(TASK_RUN)).resolves.toEqual([]);
    expect(await log.version(TASK_RUN)).toBe(0);
  });

  it('keeps aggregates in independent streams', async () => {
    const { log } = createLog();

    await log.append(TASK_RUN, 0, [createdDraft()], META);
    await log.append(OTHER_RUN, 0, [createdDraft()], META);
    await log.append(TASK_RUN, 1, [queuedDraft()], META);

    await expect(log.load(TASK_RUN)).resolves.toHaveLength(2);
    await expect(log.load(OTHER_RUN)).resolves.toHaveLength(1);
  });

  it('enforces uniqueness of (aggregate_id, sequence) in the schema', async () => {
    const { db, log } = createLog();
    await log.append(TASK_RUN, 0, [createdDraft()], META);

    const insert = db.prepare(`INSERT INTO events (aggregate_id, sequence, event_id, aggregate_type,
      type, schema_version, timestamp, causation_id, correlation_id, actor_kind, actor_id,
      sensitivity, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    expect(() =>
      insert.run(
        TASK_RUN,
        1,
        'ev_poison',
        'task_run',
        'task_run.queued',
        1,
        META.timestamp,
        null,
        META.correlationId,
        'runtime',
        'rt_poison',
        'internal',
        '{}',
      ),
    ).toThrow(/constraint/i);
    await expect(log.load(TASK_RUN)).resolves.toHaveLength(1);
  });

  it('reports the committed version, later events and events by position', async () => {
    const { log } = createLog();
    await log.append(TASK_RUN, 0, [createdDraft()], META);
    await log.append(TASK_RUN, 1, [queuedDraft(), admittedDraft()], META);

    expect(log.version(TASK_RUN)).toBe(3);
    expect(log.version(OTHER_RUN)).toBe(0);
    expect(log.loadAfter(TASK_RUN, 1).map((event) => event.sequence)).toEqual([2, 3]);
    expect(log.loadAfter(TASK_RUN, 3)).toEqual([]);
    expect(log.loadRange(TASK_RUN, 2, 3).map((event) => event.sequence)).toEqual([2, 3]);
    expect(log.eventAt(TASK_RUN, 2)?.type).toBe('task_run.queued');
    expect(log.eventAt(TASK_RUN, 4)).toBeNull();
    expect(() => log.loadAfter(TASK_RUN, -1)).toThrow(RangeError);
    expect(() => log.loadRange(TASK_RUN, 0, 1)).toThrow(RangeError);
  });

  it('resumes id minting from the committed rows', async () => {
    const { db, log } = createLog();
    await log.append(TASK_RUN, 0, [createdDraft(), queuedDraft()], META);

    const reopened = new SqliteEventLog(db, createDurableIdGenerator(db));
    await reopened.append(TASK_RUN, 2, [admittedDraft()], META);

    expect(log.eventAt(TASK_RUN, 3)?.eventId).toBe('ev_0003');
  });

  it('uses a caller-supplied identity generator', async () => {
    const ids: IdGenerator = {
      eventId: () => 'ev_caller_0001',
      commandId: () => 'cm_caller_0001',
    };
    const { log } = createLog(ids);
    await log.append(TASK_RUN, 0, [createdDraft()], META);

    expect((await log.load(TASK_RUN))[0]?.eventId).toBe('ev_caller_0001');
  });

  it('returns frozen history that callers cannot mutate', async () => {
    const { log } = createLog();
    await log.append(TASK_RUN, 0, [createdDraft()], META);

    const events = await log.load(TASK_RUN);
    const created = eventAt(events, 0);
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.payload)).toBe(true);
    expect(() => {
      (created as { sequence: number }).sequence = 99;
    }).toThrow(TypeError);
  });
});
