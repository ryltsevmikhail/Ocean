import { taskRunId, type ChatTurn } from '@runnets/domain';
import type { ChatReviewService } from './chat-review.js';
import type { ConversationStore } from './conversation-ports.js';
import type { TaskRunService } from './service.js';

export interface ChatFailureEvidence {
  readonly tasks: TaskRunService;
  readonly store: ConversationStore;
  readonly reviews?: Pick<ChatReviewService, 'review'>;
}
/** Only the first local request can prove this narrow preflight failure; no effect is settled here. */
export async function knownChatFailure(
  deps: ChatFailureEvidence,
  turn: ChatTurn,
): Promise<boolean> {
  try {
    if (
      !['dispatching', 'uncertain'].includes(turn.status) ||
      !deps.reviews ||
      turn.codingTaskId !== undefined ||
      turn.continuationReviewId !== undefined
    )
      return false;
    const state = await deps.tasks.state(taskRunId(turn.taskRunId));
    const activation = turn.activation;
    if (
      state.status !== 'failed' ||
      state.terminal?.status !== 'failed' ||
      state.id !== turn.taskRunId ||
      state.workspaceId !== 'ws_' + turn.workspaceId ||
      state.conversationId !== 'cv_' + turn.roomId ||
      state.attemptCount !== 1 ||
      state.activeAttempt?.ordinal !== 1 ||
      activation?.identity.source !== 'connection' ||
      activation.identity.kind !== 'local' ||
      activation.identity.botProfileVersion !== turn.bot.profileVersion ||
      activation.identity.providerId !== turn.bot.provider ||
      activation.identity.modelId !== turn.modelBinding?.modelId ||
      activation.identity.connectionId !== turn.modelBinding.connectionId
    )
      return false;
    const execution = state.modelExecution,
      last = execution?.lastRequest;
    const settlement = last?.settlement;
    if (
      !execution ||
      execution.startedRequests !== 1 ||
      last?.ordinal !== 1 ||
      last.attemptId !== state.activeAttempt.attemptId ||
      settlement?.ordinal !== 1 ||
      settlement.attemptId !== last.attemptId ||
      settlement.completion.kind !== 'not_sent' ||
      settlement.usage.kind !== 'unavailable' ||
      JSON.stringify(execution.activation) !== JSON.stringify(activation)
    )
      return false;
    const review = await deps.reviews.review(turn.workspaceId, turn.taskRunId);
    if (
      !review.ok ||
      review.value.taskRunId !== turn.taskRunId ||
      review.value.roomId !== turn.roomId ||
      review.value.taskVersion !== state.version ||
      review.value.taskStatus !== 'failed' ||
      review.value.turnStatus !== turn.status ||
      review.value.relatedPendingEffects !== 0
    )
      return false;
    return deps.store.atomic((tx) => {
      const current = tx.chatTurn(turn.id);
      return (
        tx.workspace()?.id === turn.workspaceId &&
        current !== null &&
        JSON.stringify(current) === JSON.stringify(turn) &&
        current.continuationReviewId === undefined &&
        deps.tasks.committedVersion(taskRunId(turn.taskRunId)) === state.version
      );
    });
  } catch {
    return false;
  }
}
