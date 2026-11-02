import { expect, it } from 'vitest';
import { taskRunId } from '@runnets/domain';
import { createTaskRun } from '../acp/session.js';
import { TaskRunService } from '@runnets/application';
import { InMemoryEventLog, SequentialIdGenerator } from '@runnets/store';
import { runTurn } from './turn.js';

it('keeps the deterministic lifecycle when no provider is configured', async () => {
  const service = new TaskRunService({
    log: new InMemoryEventLog(),
    ids: new SequentialIdGenerator(),
    clock: { now: () => new Date('2026-11-01T00:00:00Z') },
  });
  const id = taskRunId('tr_local');
  await createTaskRun({
    service,
    taskRunId: id,
    conversationId: 'cv_local',
    workspaceId: 'ws_local',
    parentTaskRunId: null,
    model: 'local',
  });
  const outcome = await runTurn({
    service,
    taskRunId: id,
    provider: null,
    model: 'local',
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    emit: () => {},
  });
  expect(outcome.kind).toBe('completed');
  const state = await service.state(id);
  if (state.status === 'absent') throw new Error('expected a created run');
  expect(state.status).toBe('succeeded');
  expect(state.budget.consumed.provider_tokens).toBe(0);
});
