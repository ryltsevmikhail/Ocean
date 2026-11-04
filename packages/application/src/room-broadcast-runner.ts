/**
 * Broadcast child-transition operations used by the host runner.
 *
 * Every transition is a durable compare against the loaded batch/turn; the host
 * never decides from its own memory whether a child was dispatched.
 */

import type { BroadcastBatch, ChatTurn } from '@runnets/domain';
import type { ProviderActivation, ProviderActivationPort } from './model-activation-types.js';
import { freezeModelActivation } from './model-activation-snapshot.js';
import { providerAdmits } from './provider-admission.js';
import { admitImageRequest } from './image-content.js';
import type { Clock } from './ports.js';
import type { ConversationStore } from './conversation-ports.js';
import type { ImageAssetResolverPort } from './image-content.js';
import type { ChatMessage } from './provider.js';
import { broadcastRoomContext } from './room-context.js';
import {
  broadcastView,
  broadcastTurnTerminal,
  type BroadcastAdmitResult,
  type BroadcastBatchView,
} from './room-broadcast-views.js';

/** Next dispatchable child, honouring frozen order and one-at-a-time serialization. */
export function nextBroadcastChild(
  store: ConversationStore,
  batchId: string,
): { batch: BroadcastBatch; turn: ChatTurn } | null {
  return store.atomic((tx) => {
    const batch = tx.broadcastBatch(batchId);
    if (batch === null || batch.state !== 'open') return null;
    const turns = tx.broadcastTurns(batch.id);
    for (const turn of turns) {
      if (turn.status === 'queued') {
        const blocked = turns.some(
          (other) =>
            (other.broadcast?.position ?? 0) < (turn.broadcast?.position ?? 0) &&
            other.status !== 'queued' &&
            !broadcastTurnTerminal(other.status),
        );
        return blocked ? null : { batch, turn };
      }
      if (!broadcastTurnTerminal(turn.status)) return null;
    }
    return null;
  });
}
/** Persist `queued → failed` for an unavailable provider/model or a removed member. */
export function refuseBroadcastChild(
  store: ConversationStore,
  batchId: string,
  turnId: string,
  failureCode = 'provider_unavailable',
): BroadcastBatchView {
  return store.atomic((tx) => {
    const batch = tx.broadcastBatch(batchId);
    if (batch === null) throw Error('unknown_batch');
    const turns = tx.broadcastTurns(batchId);
    const turn = turns.find((candidate) => candidate.id === turnId);
    if (turn === undefined || turn.status !== 'queued') throw Error('batch_closed');
    tx.putChatTurn({ ...turn, status: 'failed', failureCode });
    return broadcastView(batch, tx.broadcastTurns(batchId));
  });
}
/** Runtime-owned image authority and capability/budget guard for one child. */
export interface BroadcastContextPorts {
  readonly resolver?: ProviderActivationPort;
  readonly clock?: Clock;
  readonly images?: ImageAssetResolverPort | undefined;
  /** Returns a stable refusal code, or null when the frozen context may dispatch. */
  readonly guard?: ((messages: readonly ChatMessage[]) => string | null) | undefined;
}
/** Durable child admission: `queued → accepted` plus the frozen batch context. */
export function admitBroadcastChild(
  store: ConversationStore,
  batchId: string,
  turnId: string,
  ports: BroadcastContextPorts = {},
): BroadcastAdmitResult {
  const captured: { value: ProviderActivation | null; id: string | null } = {
    value: null,
    id: null,
  };
  const result = store.atomic<BroadcastAdmitResult>((tx) => {
    captured.value = null;
    captured.id = null;
    const batch = tx.broadcastBatch(batchId);
    if (batch === null || batch.state !== 'open') return { kind: 'closed' };
    const turns = tx.broadcastTurns(batch.id);
    const turn = turns.find((candidate) => candidate.id === turnId);
    if (turn === undefined || turn.status !== 'queued') return { kind: 'closed' };
    const room = tx.room(batch.roomId);
    if (room === null) throw Error('unknown_room');
    const refuse = (code: string) => {
      const failed = { ...turn, status: 'failed' as const, failureCode: code };
      tx.putChatTurn(failed);
      return { kind: 'refused' as const, batch, turn: failed, code };
    };
    if (room.kind !== 'group' || !room.botIds.includes(turn.bot.id))
      return refuse('broadcast_member_removed');
    const boundary = tx.history(batch.roomId, batch.boundarySeq - 1, 1)[0];
    if (
      boundary === undefined ||
      boundary.seq !== batch.boundarySeq ||
      boundary.id !== batch.messageId ||
      boundary.author !== 'user'
    )
      return refuse('broadcast_boundary_missing');
    let activation: ProviderActivation | undefined;
    let modelBinding = turn.modelBinding;
    if (ports.resolver !== undefined) {
      if (modelBinding === undefined) {
        const current = tx.bot(turn.bot.id),
          binding = tx.modelBinding(turn.bot.id);
        if (
          !current ||
          current.provider !== turn.bot.provider ||
          current.model !== turn.bot.model ||
          binding?.connectionId !== `legacy:${turn.bot.provider}` ||
          binding.modelId !== turn.bot.model
        )
          return refuse('provider_unavailable');
        modelBinding = binding;
      }
      if (!ports.clock) throw Error('admission clock required');
      const resolved = ports.resolver.resolve(
        { bot: turn.bot, binding: modelBinding },
        ports.clock.now().toISOString(),
      );
      if (!resolved.ok) return refuse(resolved.error.code);
      activation = {
        provider: resolved.value.provider,
        snapshot: freezeModelActivation(resolved.value.snapshot),
      };
      if (!providerAdmits(activation.provider, turn.bot, activation.snapshot))
        return refuse('provider_unavailable');
    }
    const context = broadcastRoomContext(
      tx,
      room,
      turn.bot,
      { text: boundary.body, messageId: batch.messageId, phase: 'persisted' },
      batch.boundarySeq,
      ports.images,
    );
    if (!context.ok) return refuse(context.error.code);
    if (activation !== undefined) {
      const images = admitImageRequest({
        provider: activation.provider,
        model: turn.bot.model,
        messages: context.value,
        capabilities: activation.snapshot.capabilities,
      });
      if (!images.ok) return refuse(images.error.code);
    }
    const refusal = ports.guard?.(context.value) ?? null;
    if (refusal !== null) return refuse(refusal);
    const accepted: ChatTurn = {
      ...turn,
      status: 'accepted',
      ...(modelBinding === undefined ? {} : { modelBinding: { ...modelBinding } }),
      ...(activation === undefined ? {} : { activation: activation.snapshot }),
    };
    captured.value = activation ?? null;
    captured.id = turn.id;
    tx.putChatTurn(accepted);
    return { kind: 'admitted', value: { batch, turn: accepted, messages: context.value } };
  });
  if (result.kind !== 'admitted' || ports.resolver === undefined) return result;
  if (
    !captured.value ||
    captured.id !== result.value.turn.id ||
    JSON.stringify(captured.value.snapshot) !== JSON.stringify(result.value.turn.activation)
  )
    throw Error('missing committed activation capture');
  return {
    kind: 'admitted',
    value: {
      ...result.value,
      turn: { ...result.value.turn, activation: captured.value.snapshot },
      activation: captured.value,
    },
  };
}
/** An uncertain child holds the room; the batch pauses for an explicit owner decision. */
export function pauseBroadcastIfUncertain(
  store: ConversationStore,
  clock: Clock,
  batchId: string,
): boolean {
  return store.atomic((tx) => {
    const batch = tx.broadcastBatch(batchId);
    if (batch === null || batch.state !== 'open') return false;
    if (!tx.broadcastTurns(batchId).some((turn) => turn.status === 'uncertain')) return false;
    tx.putBroadcastBatch({
      ...batch,
      state: 'paused',
      revision: batch.revision + 1,
      updatedAt: clock.now().toISOString(),
    });
    return true;
  });
}
/** Mark an open batch complete once every child is terminal. */
export function settleBroadcastBatch(
  store: ConversationStore,
  clock: Clock,
  batchId: string,
): BroadcastBatchView | null {
  return store.atomic((tx) => {
    const batch = tx.broadcastBatch(batchId);
    if (batch === null) return null;
    const turns = tx.broadcastTurns(batch.id);
    if (batch.state !== 'open') return broadcastView(batch, turns);
    if (turns.some((turn) => turn.status === 'queued')) return broadcastView(batch, turns);
    const next = {
      ...batch,
      state: 'completed' as const,
      revision: batch.revision + 1,
      updatedAt: clock.now().toISOString(),
    };
    tx.putBroadcastBatch(next);
    return broadcastView(next, turns);
  });
}
