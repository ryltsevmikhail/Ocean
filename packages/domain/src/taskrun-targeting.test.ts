import { describe, expect, it } from 'vitest';

import { createBudget } from './budget.js';
import type { AnyCommand, CommandPayloads, CommandType } from './commands.js';
import { decide } from './decide.js';
import type { TaskRunEventDraft } from './events.js';
import { evolve, replay } from './evolve.js';
import { conversationId, taskRunId, workspaceId } from './ids.js';
import { ABSENT, type TaskRunAggregate } from './state.js';

const actor = { kind: 'runtime', id: 'test' } as const;

function cmd<TType extends CommandType>(
  type: TType,
  expectedVersion: number,
  payload: CommandPayloads[TType],
  target = taskRunId('tr_0001'),
): AnyCommand {
  return {
    type,
    commandId: 'cm_0001',
    taskRunId: target,
    expectedVersion,
    actor,
    payload,
  } as AnyCommand;
}

const creation: CommandPayloads['CreateTaskRun'] = {
  conversationId: conversationId('cv_0001'),
  workspaceId: workspaceId('ws_0001'),
  parentTaskRunId: null,
  model: 'test-model',
  policyId: 'pl_0001',
  budget: createBudget({
    active_time_ms: null,
    provider_cost_usd: null,
    provider_tokens: null,
    tool_calls: null,
    retry_attempts: null,
    child_runs: null,
    process_starts: null,
  }).limits,
};

/** Decide one command and fold the resulting drafts, as the host would. */
function apply(aggregate: TaskRunAggregate, command: AnyCommand): TaskRunAggregate {
  const result = decide(aggregate, command);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error.message}`);
  let next = aggregate;
  for (const [index, draft] of (result.value as readonly TaskRunEventDraft[]).entries()) {
    next = evolve(next, {
      eventId: `ev_${String(index + 1).padStart(4, '0')}`,
      aggregateType: 'task_run',
      aggregateId: command.taskRunId,
      sequence: next.version + 1,
      type: draft.type,
      schemaVersion: draft.schemaVersion,
      timestamp: '2026-01-01T00:00:00Z',
      causationId: draft.causationId,
      correlationId: command.taskRunId,
      actor: draft.actor,
      sensitivity: draft.sensitivity,
      payload: draft.payload,
    } as never);
  }
  return next;
}

describe('command targeting', () => {
  it('rejects a command whose taskRunId does not match the aggregate', () => {
    const created = apply(ABSENT, cmd('CreateTaskRun', 0, creation));

    const result = decide(created, cmd('Admit', 1, {}, taskRunId('tr_0002')));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_argument');
    expect(result.error.message).toContain('tr_0002');
  });

  it('accepts a command addressed to the aggregate itself', () => {
    const created = apply(ABSENT, cmd('CreateTaskRun', 0, creation));

    expect(decide(created, cmd('Admit', 1, {})).ok).toBe(true);
  });
});

describe('creation payload validation', () => {
  it('rejects a malformed policyId as a domain result instead of throwing', () => {
    const result = decide(ABSENT, cmd('CreateTaskRun', 0, { ...creation, policyId: 'not-an-id' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_argument');
    expect(result.error.message).toContain('policyId');
  });

  it('rejects an empty model', () => {
    const result = decide(ABSENT, cmd('CreateTaskRun', 0, { ...creation, model: '  ' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_argument');
  });

  it('keeps a valid creation replayable', () => {
    const aggregate = replay([]);
    expect(aggregate.status).toBe('absent');

    const created = apply(ABSENT, cmd('CreateTaskRun', 0, creation));
    expect(created.status).toBe('created');
    if (created.status === 'absent') return;
    expect(created.policyId).toBe('pl_0001');
  });
});
