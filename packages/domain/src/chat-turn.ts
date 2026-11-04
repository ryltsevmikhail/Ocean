import type { Bot } from './conversations.js';
export type ChatTurnStatus =
  | 'queued'
  | 'accepted'
  | 'dispatching'
  | 'prepared'
  | 'completed'
  | 'failed'
  | 'uncertain'
  | 'cancelled';
/** Typed, versioned batch linkage persisted inside the turn payload. */
export interface ChatTurnBroadcastLink {
  readonly version: 1;
  readonly batchId: string;
  readonly position: number;
}
/** Durable admission and publication facts; a retry never creates new execution authority. */
export interface ChatTurn {
  readonly codingTaskId?: string;
  readonly continuationReviewId?: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly taskRunId: string;
  readonly inboundMessageId: string;
  readonly readThroughSeq: number;
  /** Present only for a broadcast child; `queued` children were never dispatched. */
  readonly broadcast?: ChatTurnBroadcastLink;
  readonly bot: Bot;
  readonly status: ChatTurnStatus;
  /** Stable visible refusal code for a child/named model that was never dispatched. */
  readonly failureCode?: string;
  readonly text: string;
  readonly preparedVersion: number | null;
  readonly stopReason: 'end_turn' | 'max_tokens';
}
