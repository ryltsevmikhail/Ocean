/**
 * Versioned command execution for application orchestration.
 *
 * An orchestrator observes aggregate state, then commits one command at the observed
 * version. The single `AnyCommand` cast lives here so call sites stay typed.
 */

import type { CommandReceipt } from './ports.js';
import type { TaskRunService } from './service.js';
import type { AnyCommand, CommandPayloads, CommandType, Result, TaskRunId } from '@runnets/domain';

export const RUNTIME_ACTOR = { kind: 'runtime', id: 'runne' } as const;

/** Execute one command at `expectedVersion`; callers re-read state afterwards. */
export async function executeStep<TType extends CommandType>(
  service: TaskRunService,
  taskRunId: TaskRunId,
  type: TType,
  payload: CommandPayloads[TType],
  expectedVersion: number,
): Promise<Result<CommandReceipt>> {
  const command = {
    type,
    commandId: `cm_${taskRunId}_${type}_${expectedVersion + 1}`,
    taskRunId,
    expectedVersion,
    actor: RUNTIME_ACTOR,
    payload,
  } as AnyCommand;
  return service.execute(command);
}
