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
  /** Set only when an owner abandon terminalised a child that was never dispatched. */
  readonly abandoned?: boolean;
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
  readonly text: string;
  readonly preparedVersion: number | null;
  readonly stopReason: 'end_turn' | 'max_tokens';
}
