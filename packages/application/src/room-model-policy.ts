import {
  admitModelTransfer,
  conversationFailure,
  ok,
  validConversationText,
  validRoomModelPolicy,
  type BotModelBinding,
  type ConversationResult,
  type ModelExecutionIdentity,
  type RoomModelPolicy,
} from '@runnets/domain';
import type { ConversationStore, ConversationTransaction } from './conversation-ports.js';
import type { ModelConnectionStorePort } from './model-connection-ports.js';
import {
  activationTransferIdentity,
  bindingTransferIdentity,
} from './room-model-policy-classification.js';

export interface GetRoomModelPolicyInput {
  readonly workspaceId: string;
  readonly roomId: string;
}
export interface RoomModelPolicySnapshot extends GetRoomModelPolicyInput {
  readonly version: 1;
  readonly policy: RoomModelPolicy;
}
export interface SetRoomModelPolicyInput {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly cloudTransfer: 'allow' | 'deny';
}
export interface RoomModelPolicyDeps {
  readonly store: ConversationStore;
  /** Reads share the surrounding conversation transaction's synchronous snapshot. */
  readonly connections: Pick<ModelConnectionStorePort, 'read'>;
}
/** Current policy must exist even when it previously allowed transfers. */
export function admitRoomModelTransfer(
  tx: Pick<ConversationTransaction, 'roomModelPolicy'>,
  roomId: string,
  identity: ModelExecutionIdentity | undefined,
): ConversationResult<void> {
  const policy = tx.roomModelPolicy(roomId);
  if (policy === null || policy.roomId !== roomId)
    return conversationFailure('model_policy_unavailable');
  return admitModelTransfer(policy, activationTransferIdentity(identity));
}
/** Every owning room participates in the binding transaction before profile or receipt writes. */
export function admitBotModelBinding(
  tx: ConversationTransaction,
  botId: string,
  binding: BotModelBinding,
  connections: Pick<ModelConnectionStorePort, 'read'>,
): ConversationResult<void> {
  const identity = bindingTransferIdentity(binding, connections);
  for (const room of tx.rooms()) {
    if (!(room.kind === 'direct' ? room.botId === botId : room.botIds.includes(botId))) continue;
    const policy = tx.roomModelPolicy(room.id);
    if (policy === null || policy.roomId !== room.id)
      return conversationFailure('model_policy_unavailable');
    const admitted = admitModelTransfer(policy, identity);
    if (!admitted.ok) return admitted;
  }
  return ok(undefined);
}
/** Policy, CAS and historical receipt have one transaction authority. Deny never claims cleanup. */
export class RoomModelPolicyService {
  readonly #deps: RoomModelPolicyDeps;
  constructor(deps: RoomModelPolicyDeps) {
    this.#deps = deps;
  }
  get(input: GetRoomModelPolicyInput): ConversationResult<RoomModelPolicySnapshot> {
    if (![input.workspaceId, input.roomId].every((id) => validConversationText(id, 128)))
      return conversationFailure('invalid_input');
    return this.#deps.store.atomic((tx) => {
      if (tx.workspace()?.id !== input.workspaceId)
        return conversationFailure('workspace_conflict');
      const room = tx.room(input.roomId);
      if (room === null) return conversationFailure('unknown_room');
      if (room.workspaceId !== input.workspaceId) return conversationFailure('workspace_conflict');
      const policy = tx.roomModelPolicy(room.id);
      if (!validRoomModelPolicy(policy) || policy.roomId !== room.id)
        return conversationFailure('model_policy_unavailable');
      return ok({
        version: 1,
        workspaceId: input.workspaceId,
        roomId: room.id,
        policy: {
          roomId: policy.roomId,
          revision: policy.revision,
          cloudTransfer: policy.cloudTransfer,
        },
      });
    });
  }
  set(input: SetRoomModelPolicyInput): ConversationResult<RoomModelPolicy> {
    if (
      ![input.workspaceId, input.roomId, input.requestId].every((id) =>
        validConversationText(id, 128),
      ) ||
      (input.cloudTransfer !== 'allow' && input.cloudTransfer !== 'deny') ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      return conversationFailure('invalid_input');
    const request = {
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      cloudTransfer: input.cloudTransfer,
    };
    const binding = JSON.stringify(['SetRoomModelPolicy', request]);
    return this.#deps.store.atomic((tx) => {
      const previous = tx.receipt(request.requestId);
      if (previous !== null)
        return previous.binding === binding &&
          previous.reply.kind === 'room_model_policy' &&
          validRoomModelPolicy(previous.reply.data) &&
          previous.reply.data.roomId === request.roomId
          ? ok({ ...previous.reply.data })
          : conversationFailure('request_conflict');
      if (tx.workspace()?.id !== request.workspaceId)
        return conversationFailure('workspace_conflict');
      const room = tx.room(request.roomId);
      if (room === null) return conversationFailure('unknown_room');
      if (room.workspaceId !== request.workspaceId)
        return conversationFailure('workspace_conflict');
      const current = tx.roomModelPolicy(room.id);
      if (!validRoomModelPolicy(current) || current.roomId !== room.id)
        return conversationFailure('model_policy_unavailable');
      if (current.revision !== request.expectedRevision)
        return conversationFailure('model_policy_revision_conflict');
      if (request.cloudTransfer === 'deny') {
        const members = room.kind === 'direct' ? [room.botId] : room.botIds;
        if (
          members.some(
            (id) =>
              bindingTransferIdentity(tx.modelBinding(id), this.#deps.connections) !== 'local',
          )
        )
          return conversationFailure('model_policy_members_conflict');
        const held = tx.chatTurns().some((turn) => {
          if (turn.roomId !== room.id || turn.workspaceId !== request.workspaceId) return false;
          if (turn.status === 'queued')
            return bindingTransferIdentity(turn.modelBinding, this.#deps.connections) !== 'local';
          return (
            ['accepted', 'dispatching', 'prepared', 'uncertain'].includes(turn.status) &&
            activationTransferIdentity(turn.activation?.identity) !== 'local'
          );
        });
        if (held || tx.roomTasks?.pendingTransfer(room.id))
          return conversationFailure('model_policy_work_conflict');
      }
      const policy: RoomModelPolicy = {
        roomId: room.id,
        cloudTransfer: request.cloudTransfer,
        revision: current.revision + 1,
      };
      tx.putRoomModelPolicy(policy);
      tx.putReceipt(request.requestId, {
        binding,
        reply: { kind: 'room_model_policy', data: policy },
      });
      return ok(policy);
    });
  }
}
