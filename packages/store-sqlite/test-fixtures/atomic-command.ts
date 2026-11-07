/* eslint-disable no-restricted-imports -- Same-package atomic-command storage fixture. */
import { TaskRunService } from '@runnets/application';
import {
  conversationId,
  taskRunId,
  unlimitedBudget,
  workspaceId,
  type AnyCommand,
} from '@runnets/domain';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEventLog } from '../src/event-log.js';
import { initializeSchema } from '../src/schema.js';
import { createDurableIdGenerator } from '../src/id-source.js';

export const command: Extract<AnyCommand, { type: 'CreateTaskRun' }> = {
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
export function setup() {
  const db = new DatabaseSync(':memory:');
  initializeSchema(db);
  const ids = createDurableIdGenerator(db);
  const log = new SqliteEventLog(db, ids);
  const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
  return { db, log, service: new TaskRunService({ log, clock, ids }), clock, ids };
}
