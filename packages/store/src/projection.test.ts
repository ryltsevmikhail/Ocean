import { describe, expect, it } from 'vitest';

import type { AppendMeta } from '@runnets/application';
import {
  ABSENT,
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
import { projectTaskRun } from './projection.js';

const TASK_RUN_ID = taskRunId('tr_0001');

const ACTOR: Actor = { kind: 'runtime', id: 'runtime-1' };

const META: AppendMeta = {
  correlationId: 'tr_0001',
  timestamp: '2026-01-01T00:00:00.000Z',
  actorId: 'runtime-1',
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

function newLog(): InMemoryEventLog {
  return new InMemoryEventLog(new SequentialIdGenerator());
}

describe('projectTaskRun', () => {
  it('returns the absent aggregate when nothing is committed', async () => {
    const log = newLog();
    await expect(projectTaskRun(log, TASK_RUN_ID)).resolves.toEqual(ABSENT);
  });

  it('rebuilds the aggregate by replaying the committed stream', async () => {
    const log = newLog();
    await log.append(TASK_RUN_ID, 0, [createdDraft()], META);
    await log.append(TASK_RUN_ID, 1, [draft('task_run.queued', {}, { actor: ACTOR })], META);
    await log.append(TASK_RUN_ID, 2, [draft('task_run.admitted', {}, { actor: ACTOR })], META);
    await log.append(
      TASK_RUN_ID,
      3,
      [
        draft(
          'attempt.started',
          {
            attemptId: 'at_0001',
            ordinal: 1,
            reason: 'initial',
            provider: 'provider-a',
            model: 'model-a',
          },
          { actor: ACTOR },
        ),
      ],
      META,
    );

    const aggregate = await projectTaskRun(log, TASK_RUN_ID);

    expect(aggregate.status).toBe('running');
    expect(aggregate.version).toBe(4);
    if (aggregate.status === 'absent') throw new Error('expected a created aggregate');
    expect(aggregate.conversationId).toBe('cv_0001');
    expect(aggregate.model).toBe('model-a');
    expect(aggregate.activeAttempt?.attemptId).toBe('at_0001');
    expect(aggregate.attemptCount).toBe(1);
  });

  it('projects only the requested aggregate', async () => {
    const log = newLog();
    await log.append(TASK_RUN_ID, 0, [createdDraft()], META);

    await expect(projectTaskRun(log, taskRunId('tr_0002'))).resolves.toEqual(ABSENT);
    await expect(projectTaskRun(log, TASK_RUN_ID)).resolves.toMatchObject({
      status: 'created',
      version: 1,
    });
  });
});
