/**
 * Scripted TaskRun lifecycle.
 *
 * This is the smallest end-to-end proof that the pieces fit: commands are
 * decided by the domain, committed by the event log, and the final state is
 * rebuilt from the committed stream alone.
 */

import {
  conversationId,
  replay,
  taskRunId as makeTaskRunId,
  workspaceId,
  type AnyCommand,
  type CommandPayloads,
  type CommandType,
  type TaskRunAggregate,
  type TaskRunId,
} from '@runnets/domain';
import type { CommandReceipt, TaskRunService } from '@runnets/application';
import { TaskRunService as Service } from '@runnets/application';
import {
  InMemoryCommandDedup,
  InMemoryEventLog,
  SequentialIdGenerator,
  systemClock,
} from '@runnets/store';

export interface DemoRun {
  readonly taskRunId: TaskRunId;
  readonly receipts: readonly CommandReceipt[];
  readonly state: TaskRunAggregate;
}

const ACTOR = { kind: 'user', id: 'cli' } as const;

/** Wire the adapters exactly as a host would, with no hidden global state. */
export function createService(): TaskRunService {
  return new Service({
    log: new InMemoryEventLog(),
    clock: systemClock,
    ids: new SequentialIdGenerator(),
    dedup: new InMemoryCommandDedup(),
  });
}

/** Run a deterministic lifecycle: create, admit, execute, checkpoint, succeed. */
export async function runDemo(): Promise<DemoRun> {
  const service = createService();
  const taskRunId = makeTaskRunId('tr_demo0001');
  const receipts: CommandReceipt[] = [];
  let version = 0;
  let ordinal = 0;

  const step = async <TType extends CommandType>(
    type: TType,
    payload: CommandPayloads[TType],
  ): Promise<void> => {
    ordinal += 1;
    const command = {
      type,
      commandId: `cm_${String(ordinal).padStart(4, '0')}`,
      taskRunId,
      expectedVersion: version,
      actor: ACTOR,
      payload,
    } as AnyCommand;

    const result = await service.execute(command);
    if (!result.ok) {
      throw new Error(`command ${type} failed: ${result.error.code} — ${result.error.message}`);
    }
    receipts.push(result.value);
    version = result.value.version;
  };

  await step('CreateTaskRun', {
    conversationId: conversationId('cv_demo0001'),
    workspaceId: workspaceId('ws_demo0001'),
    parentTaskRunId: null,
    model: 'deepseek-flash',
    policyId: 'pl_demo0001',
    budget: {
      active_time_ms: 900_000,
      provider_cost_usd: 2,
      provider_tokens: 200_000,
      tool_calls: 64,
      retry_attempts: 3,
      child_runs: 2,
      process_starts: 32,
    },
  });
  await step('Admit', {});
  await step('Schedule', {});
  await step('StartAttempt', {
    attemptId: 'at_demo0001',
    reason: 'initial',
    provider: 'deepseek',
    model: 'deepseek-flash',
  });
  await step('Wait', { reason: 'approval' });
  await step('Resume', {});
  await step('BeginCheckpoint', { checkpointId: 'cp_demo0001', attemptId: 'at_demo0001' });
  // The checkpoint must reference a position that is already committed.
  await step('CommitCheckpoint', { checkpointId: 'cp_demo0001', eventPosition: version });
  await step('Complete', { summary: 'demo lifecycle finished', attemptId: 'at_demo0001' });

  const stream = await service.events(taskRunId);
  return { taskRunId, receipts, state: replay(stream) };
}
