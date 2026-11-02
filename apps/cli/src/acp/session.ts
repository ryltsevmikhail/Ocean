/**
 * ACP session helpers.
 *
 * One ACP session is one conversation; each prompt runs in its own TaskRun, so
 * a terminal run never blocks the next turn. Session state is process-local.
 */

import type { TaskRunService } from '@runnets/application';
import {
  conversationId as brandConversationId,
  taskRunId as brandTaskRunId,
  unlimitedBudget,
  workspaceId as brandWorkspaceId,
  type TaskRunId,
} from '@runnets/domain';

import { executeStep } from '../engine/commands.js';

export interface CreateRunInput {
  readonly service: TaskRunService;
  readonly taskRunId: TaskRunId;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly parentTaskRunId: TaskRunId | null;
  readonly model: string;
}

/** Commit `CreateTaskRun` for a new session turn. */
export async function createTaskRun(input: CreateRunInput): Promise<void> {
  const result = await executeStep(
    input.service,
    input.taskRunId,
    'CreateTaskRun',
    {
      conversationId: brandConversationId(input.conversationId),
      workspaceId: brandWorkspaceId(input.workspaceId),
      parentTaskRunId: input.parentTaskRunId,
      model: input.model,
      policyId: 'pl_default',
      budget: unlimitedBudget(),
    },
    0,
  );
  if (!result.ok) throw result.error;
}

/** TaskRun ids are readable per session turn: `tr_s0001_t1`. */
export function turnTaskRunId(sessionId: string, turn: number): TaskRunId {
  return brandTaskRunId(`tr_${sessionId}_t${turn}`);
}

/** Branded session conversation and workspace ids derived from the suffix. */
export function sessionIds(suffix: string): {
  readonly conversationId: string;
  readonly workspaceId: string;
} {
  return { conversationId: `cv_s${suffix}`, workspaceId: `ws_s${suffix}` };
}
