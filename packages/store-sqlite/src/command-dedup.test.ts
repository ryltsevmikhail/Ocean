import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppendMeta, CommandReceipt } from '@runnets/application';
import {
  conversationId,
  draft,
  policyId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type Actor,
  type TaskRunEvent,
  type TaskRunEventDraft,
} from '@runnets/domain';

import { SqliteCommandDedup } from './command-dedup.js';
import { SqliteEventLog } from './event-log.js';
import { createDurableIdGenerator } from './id-source.js';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';

const TASK_RUN = taskRunId('tr_0001');
const COMMAND_ID = 'cm_0001';
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

async function committedEvents(log: SqliteEventLog): Promise<readonly TaskRunEvent[]> {
  await log.append(TASK_RUN, 0, [createdDraft(), queuedDraft()], META);
  const events = await log.load(TASK_RUN);
  return events as readonly TaskRunEvent[];
}

async function createDedup(): Promise<{ dedup: SqliteCommandDedup; log: SqliteEventLog }> {
  const db = openDatabase(':memory:', DEFAULT_BUSY_TIMEOUT_MS);
  databases.push(db);
  const log = new SqliteEventLog(db, createDurableIdGenerator(db));
  return { dedup: new SqliteCommandDedup(db), log };
}

function receipt(version: number, events: readonly TaskRunEvent[]): CommandReceipt {
  return { commandId: COMMAND_ID, taskRunId: TASK_RUN, version, events };
}

describe('SqliteCommandDedup', () => {
  it('returns null for a command that has not committed', async () => {
    const { dedup } = await createDedup();

    await expect(dedup.get(COMMAND_ID)).resolves.toBeNull();
  });

  it('round-trips the committed receipt and its events', async () => {
    const { dedup, log } = await createDedup();
    const committed = receipt(2, await committedEvents(log));

    await dedup.put(committed);

    const stored = await dedup.get(COMMAND_ID);
    expect(stored).toEqual(committed);
    expect(stored?.events.map((event) => event.type)).toEqual([
      'task_run.created',
      'task_run.queued',
    ]);
    expect(stored?.events.every((event) => event.eventId.startsWith('ev_'))).toBe(true);
  });

  it('keeps the first receipt when the same command id is stored twice', async () => {
    const { dedup, log } = await createDedup();
    const first = receipt(1, await committedEvents(log));

    await dedup.put(first);
    await dedup.put(receipt(9, []));

    const stored = await dedup.get(COMMAND_ID);
    expect(stored?.version).toBe(1);
    expect(stored).toEqual(first);
  });

  it('returns a frozen event list detached from the submitted receipt', async () => {
    const { dedup, log } = await createDedup();
    const events = await committedEvents(log);
    await dedup.put(receipt(2, events));

    const stored = await dedup.get(COMMAND_ID);
    if (stored === null) throw new Error('expected a stored receipt');
    expect(Object.isFrozen(stored.events)).toBe(true);
    expect(stored.events).not.toBe(events);
  });
});
