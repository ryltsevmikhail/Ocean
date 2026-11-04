/**
 * Broadcast projections.
 *
 * Clients receive frozen recipient identities plus the durable per-child state.
 * Nothing here guesses: child state is derived from the persisted turn and the
 * batch state only explains children that were never dispatched.
 */

import {
  broadcastChildStatus,
  type BroadcastBatch,
  type BroadcastChildStatus,
  type BroadcastRecipient,
  type ChatTurn,
} from '@runnets/domain';
import type { ChatMessage } from './provider.js';

export interface BroadcastScope {
  readonly workspaceId: string;
  readonly roomId: string;
}
export interface BroadcastSubmitInput extends BroadcastScope {
  readonly requestId: string;
  readonly text: string;
  readonly attachments?: readonly string[];
}
export interface BroadcastGetInput extends BroadcastScope {
  readonly batchId?: string;
  readonly requestId?: string;
}
export interface BroadcastVoteInput extends BroadcastScope {
  readonly batchId: string;
  readonly expectedRevision: number;
}
export interface BroadcastChildView {
  readonly botId: string;
  readonly handle: string;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly turnId: string;
  readonly runId: string;
  readonly position: number;
  readonly state: BroadcastChildStatus;
  readonly resultMessageId: string | null;
  /** Why the child was refused before dispatch, when the runtime knows it. */
  readonly refusalCode?: string | null;
}
export interface BroadcastBatchView {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly boundarySeq: number;
  readonly recipients: readonly BroadcastChildView[];
  readonly state: BroadcastBatch['state'];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface BroadcastAdmission {
  readonly batch: BroadcastBatch;
  readonly turn: ChatTurn;
  readonly messages: readonly ChatMessage[];
}
export type BroadcastAdmitResult =
  | { readonly kind: 'admitted'; readonly value: BroadcastAdmission }
  | {
      readonly kind: 'refused';
      readonly batch: BroadcastBatch;
      readonly turn: ChatTurn;
      readonly code: string;
    }
  | { readonly kind: 'closed' };
export const MAX_BROADCAST_ATTACHMENTS = 4;
export const MAX_BROADCAST_BATCHES = 50;
export const broadcastId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
export function broadcastAttachments(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BROADCAST_ATTACHMENTS) return null;
  const attachments: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (!broadcastId(item) || attachments.includes(item)) return null;
    attachments.push(item);
  }
  return attachments;
}
/** Project durable batch + turns; batch state only explains never-dispatched children. */
export function broadcastView(
  batch: BroadcastBatch,
  turns: readonly ChatTurn[],
): BroadcastBatchView {
  const byTurn = new Map<string, ChatTurn>(
    turns.map((turn): [string, ChatTurn] => [turn.id, turn]),
  );
  return {
    version: 1,
    id: batch.id,
    workspaceId: batch.workspaceId,
    roomId: batch.roomId,
    requestId: batch.requestId,
    messageId: batch.messageId,
    boundarySeq: batch.boundarySeq,
    recipients: batch.recipients.map((recipient) => {
      const turn = byTurn.get(recipient.turnId);
      return {
        ...childIdentity(recipient),
        state:
          turn === undefined
            ? 'not_started'
            : broadcastChildStatus(batch, turn.status, turn.broadcast?.abandoned === true),
        resultMessageId: turn?.status === 'completed' ? 'reply_' + turn.id : null,
        refusalCode: turn?.failureCode ?? null,
      };
    }),
    state: batch.state,
    revision: batch.revision,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}
function childIdentity(
  recipient: BroadcastRecipient,
): Omit<BroadcastChildView, 'state' | 'resultMessageId'> {
  return {
    botId: recipient.botId,
    handle: recipient.handle,
    name: recipient.name,
    provider: recipient.provider,
    model: recipient.model,
    turnId: recipient.turnId,
    runId: recipient.runId,
    position: recipient.position,
  };
}
export function broadcastTurnTerminal(status: ChatTurn['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'uncertain'].includes(status);
}
