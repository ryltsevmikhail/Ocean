import {
  conversationFailure,
  ok,
  validConversationText,
  type ChatTurn,
  type ConversationResult,
} from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
import type { ConversationServiceDeps } from './conversations.js';
import type { ChatMessage, ProviderPort } from './provider.js';

export interface DirectChatRequest {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly roomId: string;
  readonly text: string;
}
export interface ChatAdmission {
  readonly turn: ChatTurn;
  readonly fresh: boolean;
  readonly messages: readonly ChatMessage[];
}
/** Admit under the same lock as the inbound record and request receipt. */
export function admitChat(
  deps: ConversationServiceDeps,
  request: DirectChatRequest,
  provider: ProviderPort | null,
): ConversationResult<ChatAdmission> {
  if (
    ![request.workspaceId, request.requestId, request.roomId].every((id) =>
      validConversationText(id, 128),
    ) ||
    !validConversationText(request.text, 16384)
  )
    return conversationFailure('invalid_input');
  const binding = JSON.stringify(['SendDirect', request.workspaceId, request.roomId, request.text]);
  return deps.store.atomic((tx) => {
    const receipt = tx.receipt(request.requestId);
    if (receipt !== null) {
      if (receipt.binding !== binding || receipt.reply.kind !== 'turn')
        return conversationFailure('request_conflict');
      const turn = tx.chatTurn(receipt.reply.data.id);
      if (turn === null) throw new Error('chat receipt has no turn');
      return ok({ turn, fresh: false, messages: [] });
    }
    if (tx.workspace()?.id !== request.workspaceId)
      return conversationFailure('workspace_conflict');
    const room = tx.room(request.roomId);
    if (room === null) return conversationFailure('unknown_room');
    const bot = tx.bot(room.botId);
    if (bot === null) return conversationFailure('unknown_bot');
    const active = tx.activeChatTurn(room.id);
    if (active !== null)
      return conversationFailure(active.status === 'uncertain' ? 'recovery_required' : 'room_busy');
    if (provider === null) return conversationFailure('provider_unavailable');
    if (
      provider.id !== bot.provider ||
      !provider.models.includes(bot.model) ||
      !provider.capabilities.streaming ||
      !provider.capabilities.usage
    )
      return conversationFailure('provider_unavailable');
    const messages: ChatMessage[] = [{ role: 'system', content: bot.role }];
    let after = 0;
    let characters = bot.role.length + request.text.length;
    for (;;) {
      const page = tx.history(room.id, after, 200);
      for (const message of page) {
        characters += message.body.length;
        if (characters > 65536) return conversationFailure('context_limit');
        messages.push({
          role: message.author === 'bot' ? 'assistant' : 'user',
          content: message.body,
        });
      }
      if (page.length < 200) break;
      after = page.at(-1)?.seq ?? after;
    }
    messages.push({ role: 'user', content: request.text });
    // A conservative local ceiling bounds request memory; never silently truncate history.
    if (!validConversationText(messages.map((m) => m.content).join('\n'), 65536))
      return conversationFailure('context_limit');
    const id = deps.nextId();
    const messageId = deps.nextId();
    const seq = tx.nextSequence(room.id);
    const turn: ChatTurn = {
      id,
      workspaceId: request.workspaceId,
      roomId: room.id,
      requestId: request.requestId,
      taskRunId: 'tr_' + id,
      inboundMessageId: messageId,
      readThroughSeq: seq,
      bot,
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
      targetBotId: bot.id,
      body: request.text,
      createdAt: deps.clock.now().toISOString(),
    });
    tx.putChatTurn(turn);
    tx.putReceipt(request.requestId, { binding, reply: { kind: 'turn', data: turn } });
    return ok({ turn, fresh: true, messages });
  });
}
/** Update only a still-matching durable phase; late results cannot release another turn. */
export function updateChat(store: ConversationStore, expected: ChatTurn, next: ChatTurn): void {
  store.atomic((tx) => {
    const current = tx.chatTurn(expected.id);
    if (current?.status !== expected.status) throw new Error('chat phase conflict');
    tx.putChatTurn(next);
  });
}
