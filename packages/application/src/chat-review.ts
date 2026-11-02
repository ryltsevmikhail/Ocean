import {
  conversationFailure,
  ok,
  taskRunId,
  validConversationText,
  type ChatReview,
  type ConversationResult,
  type TaskRunAggregate,
} from '@runnets/domain';
import type { ConversationServiceDeps } from './conversations.js';
import type { ConversationTransaction } from './conversation-ports.js';
import type { TaskRunService } from './service.js';
import type { ToolJournalPort } from './tools.js';
import { reviewVersion, type ReviewSnapshot } from './chat-review-evidence.js';
export type { ReviewSnapshot } from './chat-review-evidence.js';
export interface ChatReviewDeps extends ConversationServiceDeps {
  readonly tasks: TaskRunService;
  readonly journal: ToolJournalPort;
}
export interface AcknowledgeChatInput {
  readonly workspaceId: string;
  readonly taskRunId: string;
  readonly requestId: string;
  readonly reviewVersion: string;
  readonly reason: string;
}
export interface ReviewApprovalPort {
  /** Trusted host asks the local owner. This port is never part of a wire request. */
  confirm(snapshot: ReviewSnapshot, signal: AbortSignal): Promise<boolean>;
}
/** Owner review is a separate audited decision; it cannot settle effects or terminate tasks. */
export class ChatReviewService {
  readonly #deps: ChatReviewDeps;
  constructor(deps: ChatReviewDeps) {
    this.#deps = deps;
  }
  async review(workspaceId: string, id: string): Promise<ConversationResult<ReviewSnapshot>> {
    const state = await this.#deps.tasks.state(taskRunId(id));
    return this.#deps.store.atomic((tx) => {
      if (tx.workspace()?.id !== workspaceId) return conversationFailure('workspace_conflict');
      return this.#snapshot(tx, id, state);
    });
  }
  /** Find a held unknown turn in one room without exposing a neighbouring room's metadata. */
  async reviewRoom(
    workspaceId: string,
    roomId: string,
  ): Promise<ConversationResult<ReviewSnapshot>> {
    const id = this.#deps.store.atomic((tx) => {
      if (tx.workspace()?.id !== workspaceId) return null;
      return tx.activeChatTurn(roomId)?.taskRunId ?? null;
    });
    return id === null ? conversationFailure('review_unavailable') : this.review(workspaceId, id);
  }
  receipt(
    workspaceId: string,
    roomId: string,
    taskRunId: string,
    requestId: string,
  ): ChatReview | null {
    return this.#deps.store.atomic((tx) => {
      const reply = tx.receipt(requestId)?.reply;
      if (reply?.kind !== 'review') return null;
      const review = reply.data;
      return review.workspaceId === workspaceId &&
        review.roomId === roomId &&
        review.taskRunId === taskRunId
        ? review
        : null;
    });
  }
  async acknowledge(
    submitted: AcknowledgeChatInput,
    approval: ReviewApprovalPort,
    signal: AbortSignal,
  ): Promise<ConversationResult<ChatReview>> {
    const input = Object.freeze({ ...submitted });
    if (!validConversationText(input.requestId, 128) || !validConversationText(input.reason, 2048))
      return conversationFailure('invalid_input');
    const binding = JSON.stringify([
      'AcknowledgeTextOnly',
      input.workspaceId,
      input.taskRunId,
      input.reviewVersion,
      input.reason,
    ]);
    const retry = this.#deps.store.atomic((tx) => {
      const receipt = tx.receipt(input.requestId);
      if (receipt === null) return null;
      return receipt.binding === binding && receipt.reply.kind === 'review'
        ? ok(receipt.reply.data)
        : conversationFailure('request_conflict');
    });
    if (retry !== null) return retry;
    const seen = await this.review(input.workspaceId, input.taskRunId);
    if (!seen.ok) return seen;
    if (seen.value.version !== input.reviewVersion) return conversationFailure('review_conflict');
    if (!seen.value.canAcknowledge) return conversationFailure('review_unavailable');
    if (
      signal.aborted ||
      !(await approval.confirm(structuredClone(seen.value), signal)) ||
      signal.aborted
    )
      return conversationFailure('approval_required');
    return this.#deps.store.atomic((tx) => {
      if (tx.workspace()?.id !== input.workspaceId)
        return conversationFailure('workspace_conflict');
      const receipt = tx.receipt(input.requestId);
      if (receipt !== null)
        return receipt.binding === binding && receipt.reply.kind === 'review'
          ? ok(receipt.reply.data)
          : conversationFailure('request_conflict');
      const turn = tx.chatTurns().find((t) => t.taskRunId === input.taskRunId);
      if (
        turn === undefined ||
        turn.status !== 'uncertain' ||
        turn.continuationReviewId !== undefined
      )
        return conversationFailure('review_conflict');
      const version = reviewVersion(
        tx,
        this.#deps.tasks,
        this.#deps.journal,
        input.taskRunId,
        turn,
      );
      if (version !== input.reviewVersion) return conversationFailure('review_conflict');
      const review: ChatReview = {
        id: this.#deps.nextId(),
        workspaceId: input.workspaceId,
        roomId: turn.roomId,
        taskRunId: turn.taskRunId,
        turnId: turn.id,
        actor: 'owner',
        mode: 'text_only',
        observedVersion: version,
        reason: input.reason,
        noticeMessageId: this.#deps.nextId(),
        createdAt: this.#deps.clock.now().toISOString(),
      };
      tx.putMessage({
        id: review.noticeMessageId,
        workspaceId: input.workspaceId,
        roomId: turn.roomId,
        seq: tx.nextSequence(turn.roomId),
        author: 'user',
        targetBotId: turn.bot.id,
        body:
          'Owner permitted future text-only conversation after interrupted run ' +
          turn.taskRunId +
          '. Its earlier execution and billing outcome remain unknown. No operation was retried.',
        createdAt: review.createdAt,
      });
      tx.putReview(review);
      tx.putRoomPolicy({ roomId: turn.roomId, mode: 'text_only', reviewId: review.id });
      tx.putChatTurn({ ...turn, continuationReviewId: review.id });
      tx.putReceipt(input.requestId, { binding, reply: { kind: 'review', data: review } });
      return ok(review);
    });
  }
  #snapshot(
    tx: ConversationTransaction,
    id: string,
    state: TaskRunAggregate,
  ): ConversationResult<ReviewSnapshot> {
    const turn = tx.chatTurns().find((t) => t.taskRunId === id) ?? null;
    if (turn === null && state.status === 'absent')
      return conversationFailure('review_unavailable');
    const version = reviewVersion(tx, this.#deps.tasks, this.#deps.journal, id, turn);
    if (version === null) return conversationFailure('review_unavailable');
    if (this.#deps.tasks.committedVersion(taskRunId(id)) !== state.version)
      return conversationFailure('review_conflict');
    const effects = this.#deps.journal.inspectPending?.() ?? [];
    return ok({
      taskRunId: id,
      roomId: turn?.roomId ?? null,
      turnStatus: turn?.status ?? null,
      taskStatus: state.status,
      taskVersion: state.version,
      version,
      globalPendingEffects: effects.length,
      relatedPendingEffects: effects.filter((e) => e.taskRunId === id || e.taskRunId === '').length,
      effects: effects.map((e) => ({
        id: e.id,
        tool: e.tool,
        taskRunId: e.taskRunId,
        attemptId: e.attemptId,
        outcome: e.outcome,
      })),
      canAcknowledge: turn?.status === 'uncertain' && turn.continuationReviewId === undefined,
      mode: turn === null ? null : (tx.roomPolicy(turn.roomId)?.mode ?? null),
    });
  }
}
