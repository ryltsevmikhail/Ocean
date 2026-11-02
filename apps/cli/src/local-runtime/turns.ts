import type { DirectChatService, ProviderPort, RoomRuntimeRuns } from '@runnets/application';
import { isLocalReceiptQuery, isLocalTurnRequest } from '@runnets/contracts';

import { RuntimeQueries, type RuntimeReply } from './queries.js';

type Settlement = 'settled' | 'uncertain';
/** One owner for fresh executions. Socket lifetimes never participate in supervision. */
export class RuntimeTurns {
  readonly #jobs = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  readonly #queries: RuntimeQueries;
  #uncertain = false;
  #draining = false;
  readonly #chat: DirectChatService;
  readonly #provider: ProviderPort | null;
  constructor(
    chat: DirectChatService,
    provider: ProviderPort | null,
    runs: RoomRuntimeRuns,
    instance: string,
  ) {
    this.#queries = new RuntimeQueries(runs, instance);
    this.#chat = chat;
    this.#provider = provider;
  }

  dispatch(
    method: string,
    params: Record<string, unknown>,
    detached: AbortSignal,
  ): RuntimeReply | Promise<RuntimeReply> {
    switch (method) {
      case 'turns.submit': {
        if (!isLocalTurnRequest(params)) return { error: { code: 'invalid_params' } };
        const controller = new AbortController();
        const admitted = this.#chat.submit(
          {
            ...params,
            provider: this.#provider,
            signal: controller.signal,
            emit: () => {},
          },
          this.#draining ? 'existing_only' : 'admit',
        );
        if (!admitted.ok) {
          const code = admitted.error.code;
          return { error: { code: code === 'admission_closed' ? 'runtime_draining' : code } };
        }
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
              this.#jobs.delete(receipt.runId!);
            });
          this.#jobs.set(receipt.runId!, { controller, settled });
        }
        return { result: receipt };
      }
      case 'receipts.get':
        return isLocalReceiptQuery(params)
          ? { result: this.#chat.getReceipt(params) }
          : { error: { code: 'invalid_params' } };
      default:
        return this.#queries.dispatch(
          method,
          params,
          detached,
          typeof params['runId'] === 'string'
            ? this.#jobs.get(params['runId'])?.controller
            : undefined,
        );
    }
  }
  closeObservers() {
    this.#queries.close();
  }
  async drain(): Promise<Settlement> {
    this.#draining = true;
    for (const { controller } of this.#jobs.values()) controller.abort();
    await Promise.all(Array.from(this.#jobs.values(), (job) => job.settled));
    return this.#uncertain ? 'uncertain' : 'settled';
  }
}
