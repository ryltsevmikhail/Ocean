import { newCodingArtifacts, memoryCodingArtifacts } from './changeset-state.js';
import type {
  CodingStore,
  CodingTransaction,
  ConversationStore,
  CodingReceipt,
} from '@runnets/application';
import type { CodingTask } from '@runnets/domain';
const CODING_STATUS_TRANSITIONS: Record<CodingTask['status'], readonly CodingTask['status'][]> = {
  reserved: ['reserved', 'cancelled', 'finalizing'],
  cancelled: ['cancelled'],
  finalizing: ['finalizing', 'finalized'],
  finalized: ['finalized'],
};
/** Copy-on-write snapshots are published only after successful synchronous work. */
export class InMemoryCodingStore implements CodingStore {
  #tasks = new Map<string, CodingTask>();
  #receipts = new Map<string, CodingReceipt>();
  #active = false;
  #artifacts = newCodingArtifacts();
  readonly #conversations: ConversationStore;
  constructor(conversations: ConversationStore) {
    this.#conversations = conversations;
  }
  /** Ephemeral runtime has coding disabled and never composes finalization. */
  projectHeld(): boolean {
    return false;
  }
  atomic<T>(work: (tx: CodingTransaction) => T): T {
    if (this.#active) throw Error('nested coding transaction');
    this.#active = true;
    const tasks = structuredClone(this.#tasks),
      receipts = structuredClone(this.#receipts);
    const artifacts = structuredClone(this.#artifacts);
    try {
      const value = work({
        ...memoryCodingArtifacts(artifacts),
        task: (id) => tasks.get(id) ?? null,
        putTask: (t) => {
          const old = tasks.get(t.id);
          if (
            old &&
            (JSON.stringify({ ...old, status: t.status, worktreeRoot: t.worktreeRoot }) !==
              JSON.stringify(t) ||
              !CODING_STATUS_TRANSITIONS[old.status].includes(t.status) ||
              (old.worktreeRoot !== null && old.worktreeRoot !== t.worktreeRoot))
          )
            throw Error('Immutable coding binding');
          if (old && old.worktreeRoot === null && t.worktreeRoot !== null) {
            const bound = artifacts.worktrees.get(t.id);
            if (
              old.status !== 'reserved' ||
              bound?.state !== 'preparing' ||
              bound.root !== t.worktreeRoot
            )
              throw Error('Missing worktree intent');
          }
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
      this.#artifacts = structuredClone(artifacts);
      this.#tasks = structuredClone(tasks);
      this.#receipts = structuredClone(receipts);
      return structuredClone(value);
    } finally {
      this.#active = false;
    }
  }
}
