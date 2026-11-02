import type { Bot } from './conversations.js';
export type ChatTurnStatus =
  'accepted' | 'dispatching' | 'prepared' | 'completed' | 'failed' | 'uncertain' | 'cancelled';
/** Durable admission and publication facts; a retry never creates new execution authority. */
export interface ChatTurn {
  readonly continuationReviewId?: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly taskRunId: string;
  readonly inboundMessageId: string;
  readonly readThroughSeq: number;
  readonly bot: Bot;
  readonly status: ChatTurnStatus;
  readonly text: string;
  readonly preparedVersion: number | null;
  readonly stopReason: 'end_turn' | 'max_tokens';
}
