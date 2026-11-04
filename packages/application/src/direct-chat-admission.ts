import {
  conversationFailure,
  ok,
  roomAddress,
  validConversationText,
  type ChatTurn,
  type ConversationMessage,
  type ConversationResult,
} from '@runnets/domain';
import type { ProviderActivation, ProviderActivationPort } from './model-activation-types.js';
import { freezeModelActivation } from './model-activation-snapshot.js';
import type { ConversationStore } from './conversation-ports.js';
import { providerAdmits } from './provider-admission.js';
import type { ConversationServiceDeps } from './conversations.js';
import { admitImageRequest } from './image-content.js';
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
export type ChatAdmissionMode = 'admit' | 'existing_only';
export type ChatProviderSource =
  | { readonly resolver: ProviderActivationPort; readonly provider?: never }
  | { readonly provider: ProviderPort | null; readonly resolver?: never };
type DurableAdmission =
  | { readonly turn: ChatTurn; readonly fresh: boolean; readonly messages: readonly ChatMessage[] }
  | { readonly record: ConversationMessage };
export type ChatAdmission =
  | { readonly turn: ChatTurn; readonly fresh: false; readonly messages: readonly ChatMessage[] }
  | {
      readonly turn: ChatTurn;
      readonly fresh: true;
      readonly messages: readonly ChatMessage[];
      readonly provider: ProviderPort;
    }
  | { readonly record: ConversationMessage };

/** Bind a user request and its sole selected recipient before admitting any model dispatch. */
export function admitChat(
  deps: ConversationServiceDeps,
  request: DirectChatRequest,
  source: ProviderPort | null | ChatProviderSource,
  policy: { readonly mode: ChatAdmissionMode; readonly codingAvailable: boolean },
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
  const mode =
    source !== null && ('resolver' in source || 'provider' in source)
      ? source
      : { provider: source };
  const hasResolver = 'resolver' in mode,
    hasProvider = 'provider' in mode;
  if (
    hasResolver === hasProvider ||
    (hasResolver && typeof mode.resolver?.resolve !== 'function') ||
    (hasProvider && mode.provider === undefined)
  )
    return conversationFailure('invalid_input');
  const captured: {
    value: { id: string; provider: ProviderPort; activation?: ProviderActivation } | null;
  } = { value: null };
  const result = deps.store.atomic<ConversationResult<DurableAdmission>>((tx) => {
    captured.value = null;
    const receipt = tx.receipt(request.requestId);
    if (receipt !== null) {
      if (receipt.binding !== binding) return conversationFailure('request_conflict');
      if (receipt.reply.kind === 'message') return ok({ record: receipt.reply.data });
      if (receipt.reply.kind !== 'turn') return conversationFailure('request_conflict');
      const turn = tx.chatTurn(receipt.reply.data.id);
      if (turn === null) throw new Error('chat receipt has no turn');
      return ok({ turn, fresh: false, messages: [] });
    }
    if (policy.mode === 'existing_only') return conversationFailure('admission_closed');
    if (request.taskId !== undefined && !policy.codingAvailable)
      return conversationFailure('invalid_input');
    if (tx.workspace()?.id !== request.workspaceId)
      return conversationFailure('workspace_conflict');
    const room = tx.room(request.roomId);
    if (room === null) return conversationFailure('unknown_room');
    if (request.taskId !== undefined && tx.roomPolicy(room.id)?.mode === 'text_only')
      return conversationFailure('recovery_required');
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
    // A durable batch holds the room between its children; only Notes stay available.
    if (tx.broadcastBatchForRoom(room.id) !== null) return conversationFailure('batch_open');
    const active = tx.activeChatTurn(room.id);
    if (active !== null)
      return conversationFailure(active.status === 'uncertain' ? 'recovery_required' : 'room_busy');
    const admittedAt = deps.clock.now().toISOString();
    const modelBinding = tx.modelBinding(selected.id);
    let activation: ProviderActivation | undefined;
    if (mode.resolver !== undefined) {
      if (modelBinding === null) return conversationFailure('provider_unavailable');
      const resolved = mode.resolver.resolve({ bot: selected, binding: modelBinding }, admittedAt);
      if (!resolved.ok) return resolved;
      activation = {
        provider: resolved.value.provider,
        snapshot: freezeModelActivation(resolved.value.snapshot),
      };
    }
    const provider = activation?.provider ?? mode.provider ?? null;
    if (!providerAdmits(provider, selected, activation?.snapshot))
      return conversationFailure('provider_unavailable');
    const id = deps.nextId();
    const messageId = deps.nextId();
    const seq = tx.nextSequence(room.id);
    const context = roomContext(
      tx,
      room,
      selected,
      { text: request.text, messageId, requestId: request.requestId, phase: 'committing' },
      deps.images,
    );
    if (!context.ok) return context;
    const images = admitImageRequest({
      provider,
      model: selected.model,
      messages: context.value,
      ...(activation === undefined ? {} : { capabilities: activation.snapshot.capabilities }),
    });
    if (!images.ok) return images;
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
      ...(modelBinding === null ? {} : { modelBinding: { ...modelBinding } }),
      ...(activation === undefined ? {} : { activation: activation.snapshot }),
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
      createdAt: admittedAt,
    });
    tx.putChatTurn(turn);
    tx.putReceipt(request.requestId, { binding, reply: { kind: 'turn', data: turn } });
    captured.value = { id: turn.id, provider, ...(activation === undefined ? {} : { activation }) };
    return ok({ turn, fresh: true, messages: context.value });
  });
  if (!result.ok) return result;
  if ('record' in result.value) return ok(result.value);
  if (!result.value.fresh) return ok({ ...result.value, fresh: false });
  const capture = captured.value;
  if (
    !capture ||
    capture.id !== result.value.turn.id ||
    JSON.stringify(capture.activation?.snapshot) !== JSON.stringify(result.value.turn.activation)
  )
    throw Error('missing committed activation capture');
  const turn =
    capture.activation === undefined
      ? result.value.turn
      : { ...result.value.turn, activation: capture.activation.snapshot };
  return ok({ ...result.value, turn, fresh: true, provider: capture.provider });
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
