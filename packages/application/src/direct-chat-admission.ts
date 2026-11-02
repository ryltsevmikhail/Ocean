import {
  conversationFailure,
  ok,
  roomAddress,
  validConversationText,
  type ChatTurn,
  type ConversationMessage,
  type ConversationResult,
} from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
import type { ConversationServiceDeps } from './conversations.js';
import type { ChatMessage, ProviderPort } from './provider.js';
import { roomContext } from './room-context.js';

export interface DirectChatRequest {
  readonly taskId?: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly roomId: string;
  readonly text: string;
  readonly to?: string | undefined;
}
export type ChatAdmission =
  | { readonly turn: ChatTurn; readonly fresh: boolean; readonly messages: readonly ChatMessage[] }
  | { readonly record: ConversationMessage };

/** Bind a user request and its sole selected recipient before admitting any model dispatch. */
export function admitChat(
  deps: ConversationServiceDeps,
  request: DirectChatRequest,
  provider: ProviderPort | null,
): ConversationResult<ChatAdmission> {
  if (
    ![request.workspaceId, request.requestId, request.roomId].every((id) =>
      validConversationText(id, 128),
    ) ||
    (request.taskId !== undefined && !validConversationText(request.taskId, 128)) ||
    !validConversationText(request.text, 16384)
  )
    return conversationFailure('invalid_input');
  // Preserve the existing M2 identity exactly when no new recipient option is supplied.
  const binding = JSON.stringify([
    'SendDirect',
    request.workspaceId,
    request.roomId,
    request.text,
    ...(request.to === undefined ? [] : [request.to]),
    ...(request.taskId === undefined ? [] : [{ codingTaskId: request.taskId }]),
  ]);
  return deps.store.atomic((tx) => {
    const receipt = tx.receipt(request.requestId);
    if (receipt !== null) {
      if (receipt.binding !== binding) return conversationFailure('request_conflict');
      if (receipt.reply.kind === 'message') return ok({ record: receipt.reply.data });
      if (receipt.reply.kind !== 'turn') return conversationFailure('request_conflict');
      const turn = tx.chatTurn(receipt.reply.data.id);
      if (turn === null) throw new Error('chat receipt has no turn');
      return ok({ turn, fresh: false, messages: [] });
    }
    if (tx.workspace()?.id !== request.workspaceId)
      return conversationFailure('workspace_conflict');
    const room = tx.room(request.roomId);
    if (room === null) return conversationFailure('unknown_room');
    const address = roomAddress(request.text, request.to);
    if (!address.ok) return address;
    const memberIds = room.kind === 'direct' ? [room.botId] : room.botIds;
    const selected =
      address.value === null
        ? room.kind === 'direct'
          ? tx.bot(room.botId)
          : null
        : (tx.botByHandle(address.value) ?? tx.bot(address.value));
    if (address.value !== null && selected === null) return conversationFailure('unknown_bot');
    if (selected !== null && !memberIds.includes(selected.id))
      return conversationFailure('not_member');
    if (selected === null && request.taskId !== undefined)
      return conversationFailure('invalid_input');
    if (selected === null) {
      const record: ConversationMessage = {
        id: deps.nextId(),
        workspaceId: request.workspaceId,
        roomId: room.id,
        seq: tx.nextSequence(room.id),
        author: 'user',
        targetBotId: null,
        body: request.text,
        createdAt: deps.clock.now().toISOString(),
      };
      tx.putMessage(record);
      tx.putReceipt(request.requestId, { binding, reply: { kind: 'message', data: record } });
      return ok({ record });
    }
    const active = tx.activeChatTurn(room.id);
    if (active !== null)
      return conversationFailure(active.status === 'uncertain' ? 'recovery_required' : 'room_busy');
    if (
      provider === null ||
      provider.id !== selected.provider ||
      !provider.models.includes(selected.model) ||
      !provider.capabilities.streaming ||
      !provider.capabilities.usage
    )
      return conversationFailure('provider_unavailable');
    const context = roomContext(tx, room, selected, request.text);
    if (!context.ok) return context;
    const id = deps.nextId();
    const messageId = deps.nextId();
    const seq = tx.nextSequence(room.id);
    const turn: ChatTurn = {
      ...(request.taskId === undefined ? {} : { codingTaskId: request.taskId }),
      id,
      workspaceId: request.workspaceId,
      roomId: room.id,
      requestId: request.requestId,
      taskRunId: 'tr_' + id,
      inboundMessageId: messageId,
      readThroughSeq: seq,
      bot: selected,
      status: 'accepted',
      text: '',
      preparedVersion: null,
      stopReason: 'end_turn',
    };
    tx.putMessage({
      id: messageId,
      workspaceId: request.workspaceId,
      roomId: room.id,
      seq,
      author: 'user',
      targetBotId: selected.id,
      body: request.text,
      createdAt: deps.clock.now().toISOString(),
    });
    tx.putChatTurn(turn);
    tx.putReceipt(request.requestId, { binding, reply: { kind: 'turn', data: turn } });
    return ok({ turn, fresh: true, messages: context.value });
  });
}
/** Update only a matching durable phase. Late results cannot release another turn. */
export function updateChat(store: ConversationStore, expected: ChatTurn, next: ChatTurn): void {
  store.atomic((tx) => {
    const current = tx.chatTurn(expected.id);
    if (
      current?.status !== expected.status ||
      current?.continuationReviewId !== expected.continuationReviewId
    )
      throw new Error('chat phase conflict');
    tx.putChatTurn(next);
  });
}
