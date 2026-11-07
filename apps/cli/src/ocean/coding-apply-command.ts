import type { Runtime } from '../runtime.js';
import { required, type OceanArguments } from './arguments.js';
import { terminalCodingConfirm } from './coding-command.js';
/** The owner CLI uses the same apply service as the SDK; model toolsets never expose it. */
export async function runCodingApplyCommand(
  runtime: Runtime,
  args: OceanArguments,
  requestId: string,
): Promise<unknown> {
  const taskId = args.positional[1];
  if (!taskId) throw Error('task ID required');
  const changesetHash = required(args.flags, 'changeset');
  const reviewRequestId = required(args.flags, 'review-request');
  if (!runtime.codingApply) throw Error('application unavailable');
  const task = runtime.coding.inspect('ws_ocean', taskId);
  if (!task.ok) throw Error(task.error.code);
  const result = await runtime.codingApply.apply(
    {
      id: requestId,
      workspaceId: task.value.workspaceId,
      taskId,
      changesetHash,
      reviewRequestId,
      expectedBase: task.value.baseCommit,
    },
    { confirm: terminalCodingConfirm },
  );
  if (!result.ok) throw Error(result.error.code);
  return result.value;
}
