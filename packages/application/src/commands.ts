import { taskRunId, conversationId, workspaceId, unlimitedBudget } from '@runnets/domain';
/**
 * Versioned command execution for application orchestration.
 *
 * An orchestrator observes aggregate state, then commits one command at the observed
 * version. The single `AnyCommand` cast lives here so call sites stay typed.
 */

import type { CommandReceipt } from './ports.js';
import type { TaskRunService } from './service.js';
import type {
  AnyCommand,
  ChatTurn,
  Command,
  CommandPayloads,
  CommandType,
  Result,
  TaskRunId,
} from '@runnets/domain';

export const RUNTIME_ACTOR = { kind: 'runtime', id: 'runne' } as const;

/** Execute one command at `expectedVersion`; callers re-read state afterwards. */
export async function executeStep<TType extends CommandType>(
  service: TaskRunService,
  taskRunId: TaskRunId,
  type: TType,
  payload: CommandPayloads[TType],
  expectedVersion: number,
): Promise<Result<CommandReceipt>> {
  return service.execute(stepCommand(taskRunId, type, payload, expectedVersion) as AnyCommand);
}
export function stepCommand<TType extends CommandType>(
  taskRunId: TaskRunId,
  type: TType,
  payload: CommandPayloads[TType],
  expectedVersion: number,
): Command<TType> {
  return {
    type,
    commandId: `cm_${taskRunId}_${type}_${expectedVersion + 1}`,
    taskRunId,
    expectedVersion,
    actor: RUNTIME_ACTOR,
    payload,
  };
}

/** Same summary and request identity for live and recovered room finals. */
export function completionSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? 'turn completed' : trimmed.slice(0, 200);
}

export function createChatCommand(
  turn: ChatTurn,
  parentTaskRunId: TaskRunId | null,
): Command<'CreateTaskRun'> {
  return {
    type: 'CreateTaskRun',
    commandId: 'chat-create-' + turn.id,
    taskRunId: taskRunId(turn.taskRunId),
    expectedVersion: 0,
    actor: { kind: 'user', id: 'owner' },
    payload: {
      conversationId: conversationId('cv_' + turn.roomId),
      workspaceId: workspaceId('ws_' + turn.workspaceId),
      parentTaskRunId,
      model: turn.activation?.identity.modelId ?? turn.bot.model,
      policyId: 'pl_ocean',
      budget: unlimitedBudget(),
    },
  };
}
