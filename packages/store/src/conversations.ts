import type {
  ConversationReceipt,
  ConversationStore,
  ConversationTransaction,
} from '@runnets/application';
import type { ChatTurn, Bot, ConversationMessage, DirectRoom, Workspace } from '@runnets/domain';

interface State {
  turns: Map<string, ChatTurn>;
  workspace: Workspace | null;
  bots: Map<string, Bot>;
  rooms: Map<string, DirectRoom>;
  messages: Map<string, ConversationMessage>;
  receipts: Map<string, ConversationReceipt>;
}
/** Detached transaction copies prevent caller mutation and roll back on failed commits. */
export class InMemoryConversationStore implements ConversationStore {
  #state: State = {
    turns: new Map(),
    workspace: null,
    bots: new Map(),
    rooms: new Map(),
    messages: new Map(),
    receipts: new Map(),
  };
  #active = false;

  /** Publish the snapshot only after the whole synchronous transaction succeeds. */
  atomic<T>(work: (transaction: ConversationTransaction) => T): T {
    if (this.#active) throw new Error('nested conversation transaction');
    this.#active = true;
    const state = structuredClone(this.#state);
    const tx: ConversationTransaction = {
      chatTurn: (id) => state.turns.get(id) ?? null,
      chatTurns: () => [...state.turns.values()],
      activeChatTurn: (roomId) =>
        [...state.turns.values()].find(
          (t) =>
            t.roomId === roomId &&
            ['accepted', 'dispatching', 'prepared', 'uncertain'].includes(t.status),
        ) ?? null,
      putChatTurn: (turn) => {
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
        state.bots.set(value.id, value);
      },
      room: (id) => state.rooms.get(id) ?? null,
      directRoom: (botId) => [...state.rooms.values()].find((r) => r.botId === botId) ?? null,
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
      receipt: (id) => state.receipts.get(id) ?? null,
      putReceipt: (id, value) => {
        state.receipts.set(id, value);
      },
    };
    try {
      const result = structuredClone(work(tx));
      this.#state = structuredClone(state);
      return result;
    } finally {
      this.#active = false;
    }
  }
}
