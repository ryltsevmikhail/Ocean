/**
 * Durable one-answer-per-participant broadcast.
 *
 * Admission is one atomic commit: one user message, the context boundary, a
 * frozen ordered recipient list and one queued child turn identity per
 * recipient. Child transitions and execution live with the host runner; this
 * service owns admission, the batch revision, recovery pause and the explicit
 * owner continue/abandon decisions.
 */

import {
  conversationFailure,
  ok,
  validConversationText,
  type BroadcastBatch,
  type BroadcastRecipient,
  type ChatTurn,
  type ConversationMessage,
  type ConversationResult,
} from '@runnets/domain';
import type { Clock } from './ports.js';
import type { ConversationStore, ConversationTransaction } from './conversation-ports.js';
import {
  MAX_BROADCAST_BATCHES,
  broadcastAttachments,
  broadcastId,
  broadcastView,
  broadcastTurnTerminal,
  type BroadcastBatchView,
  type BroadcastGetInput,
  type BroadcastScope,
  type BroadcastSubmitInput,
  type BroadcastVoteInput,
} from './room-broadcast-views.js';

/** Owner-facing batch decisions and durable admission/recovery transitions. */
export class RoomBroadcastService {
  readonly #store: ConversationStore;
  readonly #clock: Clock;
  readonly #nextId: () => string;
  constructor(deps: {
    readonly store: ConversationStore;
    readonly clock: Clock;
    readonly nextId: () => string;
  }) {
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#nextId = deps.nextId;
  }
  /** One atomic admission; a retry returns the original batch, a changed payload conflicts. */
  submit(input: BroadcastSubmitInput): ConversationResult<BroadcastBatchView> {
    const attachments = broadcastAttachments(input.attachments);
    if (
      attachments === null ||
      !broadcastId(input.requestId) ||
      !validConversationText(input.text, 16384) ||
      !validConversationText(input.roomId, 128) ||
      !validConversationText(input.workspaceId, 128)
    )
      return conversationFailure('invalid_input');
    const binding = JSON.stringify([
      'Broadcast',
      input.workspaceId,
      input.roomId,
      input.text,
      attachments,
    ]);
    return this.#store.atomic((tx) => {
      const previous = tx.receipt(input.requestId);
      if (previous !== null) {
        if (previous.binding !== binding) return conversationFailure('request_conflict');
        const replay = tx.broadcastBatchByRequest(input.requestId);
        return replay === null
          ? conversationFailure('request_conflict')
          : ok(broadcastView(replay, tx.broadcastTurns(replay.id)));
      }
      if (tx.workspace()?.id !== input.workspaceId)
        return conversationFailure('workspace_conflict');
      const room = tx.room(input.roomId);
      if (room === null) return conversationFailure('unknown_room');
      if (room.kind !== 'group') return conversationFailure('invalid_input');
      if (tx.broadcastBatchForRoom(room.id) !== null) return conversationFailure('batch_open');
      if (tx.activeChatTurn(room.id) !== null) return conversationFailure('batch_open');
      if (room.botIds.some((botId) => tx.bot(botId) === null))
        throw new Error('Missing room member');
      const message: ConversationMessage = {
        id: this.#nextId(),
        workspaceId: input.workspaceId,
        roomId: room.id,
        seq: tx.nextSequence(room.id),
        author: 'user',
        targetBotId: null,
        body: input.text,
        createdAt: this.#clock.now().toISOString(),
      };
      const batchId = this.#nextId();
      const recipients: BroadcastRecipient[] = [];
      const turns: ChatTurn[] = [];
      room.botIds.forEach((botId, position) => {
        const bot = tx.bot(botId)!;
        const turnId = this.#nextId();
        const runId = 'tr_' + turnId;
        recipients.push({
          botId: bot.id,
          handle: bot.handle,
          name: bot.name,
          provider: bot.provider,
          model: bot.model,
          turnId,
          runId,
          position,
        });
        turns.push({
          id: turnId,
          workspaceId: input.workspaceId,
          roomId: room.id,
          requestId: input.requestId,
          taskRunId: runId,
          inboundMessageId: message.id,
          readThroughSeq: message.seq,
          bot,
          status: 'queued',
          text: '',
          preparedVersion: null,
          stopReason: 'end_turn',
          broadcast: { version: 1, batchId, position },
        });
      });
      const now = this.#clock.now().toISOString();
      const batch: BroadcastBatch = {
        version: 1,
        id: batchId,
        workspaceId: input.workspaceId,
        roomId: room.id,
        requestId: input.requestId,
        binding,
        messageId: message.id,
        boundarySeq: message.seq,
        recipients,
        state: 'open',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      tx.putMessage(message);
      for (const turn of turns) tx.putChatTurn(turn);
      tx.putBroadcastBatch(batch);
      // A message-kind receipt keeps Desktop attachment history association working.
      tx.putReceipt(input.requestId, { binding, reply: { kind: 'message', data: message } });
      return ok(broadcastView(batch, tx.broadcastTurns(batch.id)));
    });
  }
  /** Lost-reply recovery by durable request id or batch id. */
  get(input: BroadcastGetInput): BroadcastBatchView {
    return this.#store.atomic((tx) => {
      if (tx.workspace()?.id !== input.workspaceId) throw Error('workspace_conflict');
      if (tx.room(input.roomId) === null) throw Error('unknown_room');
      const batch =
        input.batchId !== undefined
          ? tx.broadcastBatch(input.batchId)
          : input.requestId !== undefined
            ? tx.broadcastBatchByRequest(input.requestId)
            : null;
      if (
        batch === null ||
        batch.workspaceId !== input.workspaceId ||
        batch.roomId !== input.roomId
      )
        throw Error('unknown_batch');
      return broadcastView(batch, tx.broadcastTurns(batch.id));
    });
  }
  list(input: BroadcastScope): readonly BroadcastBatchView[] {
    return this.#store.atomic((tx) => {
      if (tx.workspace()?.id !== input.workspaceId) throw Error('workspace_conflict');
      if (tx.room(input.roomId) === null) throw Error('unknown_room');
      return tx
        .broadcastBatches(input.roomId, MAX_BROADCAST_BATCHES)
        .map((batch) => broadcastView(batch, tx.broadcastTurns(batch.id)));
    });
  }
  /** Explicit owner continue: only known-not-started siblings of a paused batch. */
  continue(input: BroadcastVoteInput): BroadcastBatchView {
    return this.#store.atomic((tx) => {
      const batch = this.#voteBatch(tx, input);
      // A repeated identical vote right after applying the same vote is idempotent.
      if (batch.state === 'open' && batch.revision === input.expectedRevision + 1)
        return broadcastView(batch, tx.broadcastTurns(batch.id));
      if (batch.state !== 'paused') throw Error('batch_not_paused');
      this.#assertRevision(batch, input.expectedRevision);
      const turns = tx.broadcastTurns(batch.id);
      if (turns.some((turn) => turn.status === 'uncertain')) throw Error('batch_uncertain');
      if (turns.some((turn) => turn.status !== 'queued' && !broadcastTurnTerminal(turn.status)))
        throw Error('batch_uncertain');
      if (tx.roomPolicy(batch.roomId)?.mode === 'text_only') throw Error('batch_held');
      if (tx.activeChatTurn(batch.roomId) !== null) throw Error('batch_held');
      const next: BroadcastBatch = {
        ...batch,
        state: 'open',
        revision: batch.revision + 1,
        updatedAt: this.#clock.now().toISOString(),
      };
      tx.putBroadcastBatch(next);
      return broadcastView(next, turns);
    });
  }
  /** Explicit owner abandonment: only never-dispatched siblings; started children stay. */
  abandon(input: BroadcastVoteInput): BroadcastBatchView {
    return this.#store.atomic((tx) => {
      const batch = this.#voteBatch(tx, input);
      if (batch.state === 'abandoned' && batch.revision === input.expectedRevision + 1)
        return broadcastView(batch, tx.broadcastTurns(batch.id));
      if (batch.state !== 'paused') throw Error('batch_not_paused');
      this.#assertRevision(batch, input.expectedRevision);
      const turns = tx.broadcastTurns(batch.id);
      const next: BroadcastBatch = {
        ...batch,
        state: 'abandoned',
        revision: batch.revision + 1,
        updatedAt: this.#clock.now().toISOString(),
      };
      tx.putBroadcastBatch(next);
      return broadcastView(next, turns);
    });
  }
  /** Runtime startup: every unfinished batch pauses; queued children stay held. */
  recover(): number {
    return this.#store.atomic((tx) => {
      const open = tx.broadcastOpenBatches();
      for (const batch of open) {
        if (batch.state === 'paused') continue;
        tx.putBroadcastBatch({
          ...batch,
          state: 'paused',
          revision: batch.revision + 1,
          updatedAt: this.#clock.now().toISOString(),
        });
      }
      return open.length;
    });
  }
  #voteBatch(tx: ConversationTransaction, input: BroadcastVoteInput): BroadcastBatch {
    if (tx.workspace()?.id !== input.workspaceId) throw Error('workspace_conflict');
    const batch = tx.broadcastBatch(input.batchId);
    if (batch === null || batch.roomId !== input.roomId) throw Error('unknown_batch');
    return batch;
  }
  #assertRevision(batch: BroadcastBatch, expected: number): void {
    if (batch.revision !== expected) throw Error('revision_conflict');
  }
}
