import { InMemoryOwnerDecisions, type MemoryDecisionRows } from './owner-decisions.js';
import { InMemoryModelConnections, type MemoryModelConnections } from './model-connections.js';
import { modelConnectionRecord, unconfiguredModelConnection } from '@runnets/application';
import type {
  ConversationReceipt,
  ConversationStore,
  ConversationTransaction,
  ModelConnectionStorePort,
  ModelConnectionRecord,
  ModelConnectionReceipt,
} from '@runnets/application';
import type {
  BroadcastBatch,
  ChatReview,
  RoomExecutionPolicy,
  ChatTurn,
  Bot,
  BotModelBinding,
  ConversationMessage,
  Room,
  Workspace,
} from '@runnets/domain';

interface State extends MemoryModelConnections {
  bindings: Map<string, BotModelBinding>;
  decisions: MemoryDecisionRows;
  reviews: Map<string, ChatReview>;
  policies: Map<string, RoomExecutionPolicy>;
  turns: Map<string, ChatTurn>;
  workspace: Workspace | null;
  bots: Map<string, Bot>;
  rooms: Map<string, Room>;
  messages: Map<string, ConversationMessage>;
  receipts: Map<string, ConversationReceipt>;
  broadcasts: Map<string, BroadcastBatch>;
}
// Immutable decision rows can share their preview strings between snapshots.
function copyState({ decisions, ...conversation }: State): State {
  return { ...structuredClone(conversation), decisions: new Map(decisions) };
}
/** Detached transaction copies prevent caller mutation and roll back on failed commits. */
export class InMemoryConversationStore implements ConversationStore, ModelConnectionStorePort {
  #state: State = {
    connections: new Map([['legacy:deepseek', unconfiguredModelConnection('deepseek')]]),
    connectionReceipts: new Map(),
    bindings: new Map(),
    decisions: new Map(),
    reviews: new Map(),
    policies: new Map(),
    turns: new Map(),
    workspace: null,
    bots: new Map(),
    rooms: new Map(),
    messages: new Map(),
    receipts: new Map(),
    broadcasts: new Map(),
  };
  #draft: State | null = null;
  readonly ownerDecisions = new InMemoryOwnerDecisions(
    () => (this.#draft ?? this.#state).decisions,
  );
  readonly modelConnections = new InMemoryModelConnections(() => this.#draft ?? this.#state);
  list(): readonly ModelConnectionRecord[] {
    return this.modelConnections.list();
  }
  read(id: string): ModelConnectionRecord | null {
    return this.modelConnections.read(id);
  }
  put(record: ModelConnectionRecord, expected: number | null): void {
    this.modelConnections.put(record, expected);
  }
  activate(
    record: ModelConnectionRecord,
    expected: number | null,
    receipt: { readonly requestId: string; readonly value: ModelConnectionReceipt },
  ): void {
    this.modelConnections.activate(record, expected, receipt);
  }
  receipt(id: string): ModelConnectionReceipt | null {
    return this.modelConnections.receipt(id);
  }

  /** Publish the snapshot only after the whole synchronous transaction succeeds. */
  atomic<T>(work: (transaction: ConversationTransaction) => T): T {
    if (this.#draft) throw new Error('nested conversation transaction');
    const state = copyState(this.#state);
    this.#draft = state;
    const tx: ConversationTransaction = {
      review: (id) => state.reviews.get(id) ?? null,
      putReview: (r) => {
        if (state.reviews.has(r.id)) throw new Error('Duplicate review');
        state.reviews.set(r.id, r);
      },
      roomPolicy: (id) => state.policies.get(id) ?? null,
      putRoomPolicy: (p) => {
        state.policies.set(p.roomId, p);
      },
      chatTurn: (id) => state.turns.get(id) ?? null,
      roomChatRun: (workspaceId, roomId, runId) =>
        [...state.turns.values()].find(
          (t) => t.workspaceId === workspaceId && t.roomId === roomId && t.taskRunId === runId,
        ) ?? null,
      chatTurns: () => [...state.turns.values()],
      activeChatTurn: (roomId) =>
        [...state.turns.values()].find(
          (t) =>
            t.roomId === roomId &&
            t.continuationReviewId === undefined &&
            ['accepted', 'dispatching', 'prepared', 'uncertain'].includes(t.status),
        ) ?? null,
      putChatTurn: (turn) => {
        const previous = state.turns.get(turn.id);
        if (
          previous?.continuationReviewId !== undefined &&
          turn.continuationReviewId !== previous.continuationReviewId
        )
          throw new Error('continuation review is immutable');
        state.turns.set(turn.id, turn);
      },
      workspace: () => state.workspace,
      putWorkspace: (value) => {
        state.workspace = value;
      },
      bot: (id) => state.bots.get(id) ?? null,
      botByHandle: (handle) => [...state.bots.values()].find((b) => b.handle === handle) ?? null,
      bots: () =>
        [...state.bots.values()].sort((a, b) =>
          a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0,
        ),
      putBot: (value) => {
        if (state.bots.has(value.id)) throw new Error('duplicate bot identity');
        if (!value.model || value.model.includes('\0')) throw Error('invalid_model_binding');
        state.bots.set(value.id, value);
        const placeholder = modelConnectionRecord(unconfiguredModelConnection(value.provider));
        if (!state.connections.has(placeholder.connectionId))
          state.connections.set(placeholder.connectionId, placeholder);
        state.bindings.set(value.id, {
          connectionId: placeholder.connectionId,
          modelId: value.model,
        });
      },
      replaceBot: (bot, expectedProfileVersion) => {
        const previous = state.bots.get(bot.id);
        if (
          previous?.profileVersion !== expectedProfileVersion ||
          previous.workspaceId !== bot.workspaceId ||
          !Number.isSafeInteger(expectedProfileVersion) ||
          expectedProfileVersion < 1 ||
          !Number.isSafeInteger(bot.profileVersion) ||
          bot.profileVersion !== expectedProfileVersion + 1
        )
          throw Error('bot_profile_version_conflict');
        if ([...state.bots.values()].some((b) => b.id !== bot.id && b.handle === bot.handle))
          throw Error('handle_taken');
        state.bots.set(bot.id, bot);
      },
      modelBinding: (id) => state.bindings.get(id) ?? null,
      putModelBinding: (id, binding) => {
        if (!state.bots.has(id) || !state.connections.has(binding.connectionId))
          throw Error('model_binding_reference');
        if (
          !binding.connectionId ||
          !binding.modelId ||
          binding.connectionId.includes('\0') ||
          binding.modelId.includes('\0')
        )
          throw Error('invalid_model_binding');
        state.bindings.set(id, binding);
      },
      rooms: () => [...state.rooms.values()],
      room: (id) => state.rooms.get(id) ?? null,
      directRoom: (botId) =>
        [...state.rooms.values()].find(
          (r): r is Extract<Room, { kind: 'direct' }> => r.kind === 'direct' && r.botId === botId,
        ) ?? null,
      putRoom: (value) => {
        if (state.rooms.has(value.id)) throw new Error('duplicate room identity');
        state.rooms.set(value.id, value);
      },
      history: (roomId, after, limit) =>
        [...state.messages.values()]
          .filter((m) => m.roomId === roomId && m.seq > after)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit),
      nextSequence: (roomId) =>
        1 +
        [...state.messages.values()]
          .filter((m) => m.roomId === roomId)
          .reduce((max, message) => Math.max(max, message.seq), 0),
      putMessage: (value) => {
        if (state.messages.has(value.id)) throw new Error('duplicate message identity');
        state.messages.set(value.id, value);
      },
      broadcastBatch: (id) => state.broadcasts.get(id) ?? null,
      broadcastBatchByRequest: (requestId) =>
        [...state.broadcasts.values()].find((b) => b.requestId === requestId) ?? null,
      broadcastBatchForRoom: (roomId) =>
        [...state.broadcasts.values()].find(
          (b) => b.roomId === roomId && (b.state === 'open' || b.state === 'paused'),
        ) ?? null,
      broadcastBatches: (roomId, limit) =>
        [...state.broadcasts.values()]
          .filter((b) => b.roomId === roomId)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          .slice(0, limit),
      broadcastOpenBatches: () =>
        [...state.broadcasts.values()].filter((b) => b.state === 'open' || b.state === 'paused'),
      putBroadcastBatch: (batch) => {
        state.broadcasts.set(batch.id, batch);
      },
      broadcastTurns: (batchId) =>
        [...state.turns.values()]
          .filter((t) => t.broadcast?.batchId === batchId)
          .sort((a, b) => (a.broadcast?.position ?? 0) - (b.broadcast?.position ?? 0)),
      receipt: (id) => state.receipts.get(id) ?? null,
      completeReviewRequest: (id, decisionId, binding, review) => {
        const old = state.receipts.get(id);
        if (
          old?.binding !== binding ||
          old.reply.kind !== 'review_request' ||
          old.reply.data.id !== decisionId ||
          old.reply.data.workspaceId !== review.workspaceId ||
          old.reply.data.roomId !== review.roomId ||
          old.reply.data.taskRunId !== review.taskRunId
        )
          throw Error('request_conflict');
        state.receipts.set(id, { binding, reply: { kind: 'review', data: review } });
      },
      putReceipt: (id, value) => {
        if (state.receipts.has(id)) throw Error('request_conflict');
        state.receipts.set(id, value);
      },
    };
    try {
      const result = structuredClone(work(tx));
      this.#state = copyState(state);
      return result;
    } finally {
      this.#draft = null;
    }
  }
}
