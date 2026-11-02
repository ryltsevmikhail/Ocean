import { describe, expect, it } from 'vitest';

import type { AppendMeta } from '@runnets/application';
import type { EventEnvelope } from '@runnets/domain';
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

import { InMemoryEventLog } from './in-memory-event-log.js';
import { SequentialIdGenerator } from './id-generator.js';

const TASK_RUN_ID = taskRunId('tr_0001');

const ACTOR: Actor = { kind: 'runtime', id: 'draft-actor' };

const META: AppendMeta = {
  correlationId: 'tr_0001',
  timestamp: '2026-01-01T00:00:00.000Z',
  actorId: 'meta-actor',
};

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

function eventAt(events: readonly EventEnvelope[], index: number): EventEnvelope {
  const event = events[index];
  if (event === undefined) throw new Error(`event ${index} is missing from the stream`);
  return event;
}

function newLog(): InMemoryEventLog {
  return new InMemoryEventLog(new SequentialIdGenerator());
}

describe('InMemoryEventLog', () => {
  it('assigns contiguous per-aggregate sequences across appends', async () => {
    const log = newLog();

    await log.append(TASK_RUN_ID, 0, [createdDraft()], META);
    const second = await log.append(
      TASK_RUN_ID,
      1,
      [
        draft('task_run.queued', {}, { actor: ACTOR }),
        draft('task_run.admitted', {}, { actor: ACTOR }),
      ],
      META,
    );
    expect(second.ok).toBe(true);

    const events = await log.load(TASK_RUN_ID);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual([
      'task_run.created',
      'task_run.queued',
      'task_run.admitted',
    ]);
    expect(events.map((event) => event.eventId)).toEqual(['ev_0001', 'ev_0002', 'ev_0003']);
    expect(events.every((event) => event.aggregateId === TASK_RUN_ID)).toBe(true);
    expect(events.every((event) => event.aggregateType === 'task_run')).toBe(true);
  });

  it('defaults to a private sequential id generator', async () => {
    const log = new InMemoryEventLog();
    await log.append(TASK_RUN_ID, 0, [createdDraft()], META);

    expect(eventAt(await log.load(TASK_RUN_ID), 0).eventId).toBe('ev_0001');
  });

  it('builds the envelope from the draft and append metadata', async () => {
    const log = newLog();
    await log.append(TASK_RUN_ID, 0, [createdDraft()], META);

    const created = eventAt(await log.load(TASK_RUN_ID), 0);
    expect(created.correlationId).toBe('tr_0001');
    expect(created.causationId).toBeNull();
    expect(created.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(created.schemaVersion).toBe(1);
    expect(created.sensitivity).toBe('internal');
    // Actor rule: kind from the draft, id from AppendMeta.actorId.
    expect(created.actor).toEqual({ kind: 'runtime', id: 'meta-actor' });
  });

  it('returns an empty stream for an unknown aggregate', async () => {
    const log = newLog();
    await expect(log.load(taskRunId('tr_0002'))).resolves.toEqual([]);
  });

  it('rejects a stale expected version without appending', async () => {
    const log = newLog();
    await log.append(TASK_RUN_ID, 0, [createdDraft()], META);

    const outcome = await log.append(
      TASK_RUN_ID,
      0,
      [draft('task_run.queued', {}, { actor: ACTOR })],
      META,
    );

    expect(outcome).toEqual({ ok: false, actualVersion: 1 });
    await expect(log.load(TASK_RUN_ID)).resolves.toHaveLength(1);
  });

  it('reports the actual version when the expected version is ahead', async () => {
    const log = newLog();

    const outcome = await log.append(TASK_RUN_ID, 3, [createdDraft()], META);

    expect(outcome).toEqual({ ok: false, actualVersion: 0 });
    await expect(log.load(TASK_RUN_ID)).resolves.toEqual([]);
  });

  it('keeps aggregates in independent streams', async () => {
    const log = newLog();
    const other = taskRunId('tr_0002');

    await log.append(TASK_RUN_ID, 0, [createdDraft()], META);
    await log.append(other, 0, [createdDraft()], META);
    await log.append(TASK_RUN_ID, 1, [draft('task_run.queued', {}, { actor: ACTOR })], META);

    await expect(log.load(TASK_RUN_ID)).resolves.toHaveLength(2);
    await expect(log.load(other)).resolves.toHaveLength(1);
  });

  it('returns frozen history that callers cannot mutate', async () => {
    const log = newLog();
    await log.append(TASK_RUN_ID, 0, [createdDraft()], META);

    const events = await log.load(TASK_RUN_ID);
    const created = eventAt(events, 0);

    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.payload)).toBe(true);

    expect(() => {
      (events as EventEnvelope[]).push(created);
    }).toThrow(TypeError);
    expect(() => {
      (created as { sequence: number }).sequence = 99;
    }).toThrow(TypeError);
    expect(() => {
      (created.payload as { model: string }).model = 'tampered';
    }).toThrow(TypeError);
  });

  it('copies payloads so later draft mutation cannot rewrite history', async () => {
    const log = newLog();
    const source = createdDraft();
    await log.append(TASK_RUN_ID, 0, [source], META);

    (source.payload as { model: string }).model = 'mutated-after-append';

    const created = eventAt(await log.load(TASK_RUN_ID), 0);
    expect(created.payload).not.toBe(source.payload);
    expect((created.payload as { model: string }).model).toBe('model-a');
  });
});
