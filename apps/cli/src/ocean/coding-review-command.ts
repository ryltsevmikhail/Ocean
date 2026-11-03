import { randomUUID } from 'node:crypto';
import { taskRunId } from '@runnets/domain';
import { ModelCodingReviewer, type ProviderPort } from '@runnets/application';
import type { Runtime } from '../runtime.js';
import type { OceanArguments } from './arguments.js';
import { terminalCodingConfirm } from './coding-command.js';

export async function runCodingReviewCommand(
  runtime: Runtime,
  args: OceanArguments,
  requestId: string,
  provider: ProviderPort | null,
): Promise<unknown> {
  const id = args.positional[1];
  if (!id) throw Error('task ID required');
  const task = runtime.coding.inspect('ws_ocean', id);
  if (!task.ok) throw Error(task.error.code);
  const captured = await runtime.codingChanges.capture(
    {
      workspaceId: task.value.workspaceId,
      taskId: id,
      roomId: task.value.ownerRoomId,
      botId: task.value.devBotId,
      policyVersion: task.value.policyVersion,
      capability: 'project_read',
    },
    'capture-' + requestId,
  );
  if (!captured.ok) throw Error(captured.error.code);
  if (args.positional[0] === 'diff') return captured.value;
  if (args.positional[0] !== 'review' || !runtime.codingReview) throw Error('review unavailable');
  const bots = runtime.conversations.bots(task.value.workspaceId);
  if (!bots.ok) throw Error(bots.error.code);
  const reviewer = bots.value.find((bot) => bot.id === task.value.reviewBotId);
  const to = args.flags.get('to');
  if (!reviewer || !to || (to !== reviewer.id && to !== reviewer.handle))
    throw Error('exact reviewer required');
  if (!provider || provider.id !== reviewer.provider || !provider.models.includes(reviewer.model))
    throw Error('provider_unavailable');
  const requested = await runtime.codingReview.request(
    {
      id: requestId,
      workspaceId: task.value.workspaceId,
      taskId: id,
      changesetHash: captured.value.hash,
    },
    { confirm: terminalCodingConfirm },
  );
  if (!requested.ok) throw Error(requested.error.code);
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const result = await runtime.codingReview.dispatch(
      requestId,
      new ModelCodingReviewer({
        tasks: runtime.service,
        provider,
        model: reviewer.model,
        nextRunId: () => taskRunId('tr_' + randomUUID().replaceAll('-', '')),
        signal: controller.signal,
        emit: () => {},
      }),
    );
    if (!result.ok) throw Error(result.error.code);
    return { request: requested.value, verdict: result.value };
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
