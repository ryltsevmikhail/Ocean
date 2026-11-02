import type { DirectChatService, ProviderPort } from '@runnets/application';
import {
  isLocalReceiptQuery,
  isLocalRunQuery,
  isLocalTurnRequest,
  type LocalTurnReceipt,
  type LocalRunSnapshot,
} from '@runnets/contracts';

type Settlement = 'settled' | 'uncertain';
type Reply = { result: LocalTurnReceipt | LocalRunSnapshot | null } | { error: { code: string } };
/** One owner for fresh executions. Socket lifetimes never participate in supervision. */
export class RuntimeTurns {
  readonly #jobs = new Map<AbortController, Promise<void>>();
  #uncertain = false;
  #draining = false;
  readonly #chat: DirectChatService;
  readonly #provider: ProviderPort | null;
  constructor(chat: DirectChatService, provider: ProviderPort | null) {
    this.#chat = chat;
    this.#provider = provider;
  }

  dispatch(method: string, params: Record<string, unknown>): Reply | Promise<Reply> {
    switch (method) {
      case 'turns.submit': {
        if (!isLocalTurnRequest(params)) return { error: { code: 'invalid_params' } };
        if (this.#draining) return { error: { code: 'runtime_draining' } };
        const controller = new AbortController();
        const admitted = this.#chat.submit({
          ...params,
          provider: this.#provider,
          signal: controller.signal,
          emit: () => {},
        });
        if (!admitted.ok) return { error: { code: admitted.error.code } };
        const { receipt, completion } = admitted.value;
        if (completion) {
          const settled = completion
            .then(
              (turn) => {
                if (turn.status === 'uncertain') this.#uncertain = true;
              },
              () => {
                this.#uncertain = true;
              },
            )
            .finally(() => {
              this.#jobs.delete(controller);
            });
          this.#jobs.set(controller, settled);
        }
        return { result: receipt };
      }
      case 'receipts.get':
        return isLocalReceiptQuery(params)
          ? { result: this.#chat.getReceipt(params) }
          : { error: { code: 'invalid_params' } };
      case 'runs.get':
        return isLocalRunQuery(params)
          ? this.#chat.getRun(params).then((result) => ({ result }))
          : { error: { code: 'invalid_params' } };
      default:
        return { error: { code: 'method_not_found' } };
    }
  }
  async drain(): Promise<Settlement> {
    this.#draining = true;
    for (const controller of this.#jobs.keys()) controller.abort();
    await Promise.all(this.#jobs.values());
    return this.#uncertain ? 'uncertain' : 'settled';
  }
}
