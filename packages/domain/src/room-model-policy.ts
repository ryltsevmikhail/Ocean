import {
  conversationFailure,
  validConversationText,
  type ConversationResult,
} from './conversations.js';
import { ok } from './errors.js';

export interface RoomModelPolicy {
  readonly roomId: string;
  readonly cloudTransfer: 'allow' | 'deny';
  readonly revision: number;
}
/** Minimal classification evidence; host identity supplies no locality evidence. */
export type ModelTransferIdentity = 'local' | 'cloud' | 'unknown';

export function validRoomModelPolicy(value: unknown): value is RoomModelPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Partial<RoomModelPolicy>;
  return (
    typeof p.roomId === 'string' &&
    validConversationText(p.roomId, 128) &&
    (p.cloudTransfer === 'allow' || p.cloudTransfer === 'deny') &&
    typeof p.revision === 'number' &&
    Number.isSafeInteger(p.revision) &&
    p.revision >= 1
  );
}
/** Admission evidence only: never cleanup, cancellation or authority to retry an old effect. */
export function admitModelTransfer(
  policy: RoomModelPolicy,
  identity: ModelTransferIdentity,
): ConversationResult<void> {
  if (!validRoomModelPolicy(policy)) return conversationFailure('model_policy_unavailable');
  return policy.cloudTransfer === 'deny' && identity !== 'local'
    ? conversationFailure('model_transfer_denied')
    : ok(undefined);
}
