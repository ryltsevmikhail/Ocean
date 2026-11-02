import type {
  CodingStore,
  CodingTransaction,
  ConversationStore,
  CodingReceipt,
} from '@runnets/application';
import type { CodingTask } from '@runnets/domain';
/** Copy-on-write snapshots are published only after successful synchronous work. */
export class InMemoryCodingStore implements CodingStore {
  #tasks = new Map<string, CodingTask>();
  #receipts = new Map<string, CodingReceipt>();
  #active = false;
  readonly #conversations: ConversationStore;
  constructor(conversations: ConversationStore) {
    this.#conversations = conversations;
  }
  atomic<T>(work: (tx: CodingTransaction) => T): T {
    if (this.#active) throw Error('nested coding transaction');
    this.#active = true;
    const tasks = structuredClone(this.#tasks),
      receipts = structuredClone(this.#receipts);
    try {
      const value = work({
        task: (id) => tasks.get(id) ?? null,
        putTask: (t) => {
          const old = tasks.get(t.id);
          if (
            old &&
            (JSON.stringify({ ...old, status: t.status }) !== JSON.stringify(t) ||
              (old.status === 'cancelled' && t.status !== 'cancelled'))
          )
            throw Error('Immutable coding binding');
          tasks.set(t.id, structuredClone(t));
        },
        receipt: (id) => receipts.get(id) ?? null,
        putReceipt: (id, r) => {
          if (receipts.has(id)) throw Error('duplicate coding receipt');
          receipts.set(id, structuredClone(r));
        },
        workspaceRoot: (id) =>
          this.#conversations.atomic((tx) =>
            tx.workspace()?.id === id ? tx.workspace()!.root : null,
          ),
        participates: (ws, room, bot) =>
          this.#conversations.atomic((tx) => {
            const r = tx.room(room),
              b = tx.bot(bot);
            return (
              tx.workspace()?.id === ws &&
              r?.workspaceId === ws &&
              b?.workspaceId === ws &&
              (r.kind === 'direct' ? r.botId === bot : r.botIds.includes(bot))
            );
          }),
      });
      this.#tasks = structuredClone(tasks);
      this.#receipts = structuredClone(receipts);
      return structuredClone(value);
    } finally {
      this.#active = false;
    }
  }
}
