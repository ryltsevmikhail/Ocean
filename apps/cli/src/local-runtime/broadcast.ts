/**
 * Host-owned broadcast runner.
 *
 * Children are dispatched one at a time in frozen order. Each child is durably
 * admitted (`queued → accepted`) before its provider effect, executes through
 * the shared turn executor, and only then may the next child start. An
 * in-flight child is never silently abandoned on shutdown; drain aborts it
 * through the normal cancellation path and reports uncertainty honestly.
 */

import {
  isLocalBroadcastGet,
  isLocalBroadcastList,
  isLocalBroadcastSubmit,
  isLocalBroadcastVote,
} from '@runnets/contracts';
import {
  admitBroadcastChild,
  executeChatTurn,
  nextBroadcastChild,
  pauseBroadcastIfUncertain,
  providerAdmits,
  refuseBroadcastChild,
  settleBroadcastBatch,
  type ChatTurnExecutionDeps,
  type Clock,
  type ProviderPort,
  type RoomBroadcastService,
} from '@runnets/application';
import type { RuntimeReply } from './queries.js';

export interface RuntimeBroadcastsOptions {
  readonly service: RoomBroadcastService;
  readonly execution: ChatTurnExecutionDeps;
  readonly clock: Clock;
  /** Task 1 activation snapshot getter; captured once per dispatched child. */
  readonly provider: () => ProviderPort | null;
}
const stable = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z_]{1,64}$/.test(message) ? message : 'runtime_failure';
};
export class RuntimeBroadcasts {
  readonly #service: RoomBroadcastService;
  readonly #execution: ChatTurnExecutionDeps;
  readonly #clock: Clock;
  readonly #provider: () => ProviderPort | null;
  readonly #jobs = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  readonly #children = new Map<string, AbortController>();
  #draining = false;
  #uncertain = false;
  constructor(options: RuntimeBroadcastsOptions) {
    this.#service = options.service;
    this.#execution = options.execution;
    this.#clock = options.clock;
    this.#provider = options.provider;
  }
  dispatch(
    method: string,
    params: Record<string, unknown>,
    detached: AbortSignal,
  ): RuntimeReply | Promise<RuntimeReply> {
    void detached;
    if (this.#draining && method !== 'broadcasts.get' && method !== 'broadcasts.list')
      return { error: { code: 'runtime_draining' } };
    try {
      switch (method) {
        case 'broadcasts.submit': {
          if (!isLocalBroadcastSubmit(params)) return { error: { code: 'invalid_params' } };
          const submitted = this.#service.submit(params);
          if (!submitted.ok) return { error: { code: submitted.error.code } };
          this.#start(submitted.value.id);
          return { result: submitted.value };
        }
        case 'broadcasts.get':
          return isLocalBroadcastGet(params)
            ? { result: this.#service.get(params) }
            : { error: { code: 'invalid_params' } };
        case 'broadcasts.list':
          return isLocalBroadcastList(params)
            ? { result: this.#service.list(params) }
            : { error: { code: 'invalid_params' } };
        case 'broadcasts.continue': {
          if (!isLocalBroadcastVote(params)) return { error: { code: 'invalid_params' } };
          const view = this.#service.continue(params);
          this.#start(view.id);
          return { result: view };
        }
        case 'broadcasts.abandon':
          return isLocalBroadcastVote(params)
            ? { result: this.#service.abandon(params) }
            : { error: { code: 'invalid_params' } };
        default:
          return { error: { code: 'invalid_params' } };
      }
    } catch (error) {
      return { error: { code: stable(error) } };
    }
  }
  /** Abort the in-flight child through its normal cancellation path and await settlement. */
  async drain(): Promise<'settled' | 'uncertain'> {
    this.#draining = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    await Promise.all([...this.#jobs.values()].map((job) => job.settled));
    return this.#uncertain ? 'uncertain' : 'settled';
  }
  get draining(): boolean {
    return this.#draining;
  }
  /** Existing `runs.cancel` keeps one controller per in-flight child run. */
  controllerFor(runId: string): AbortController | undefined {
    return this.#children.get(runId);
  }
  #start(batchId: string): void {
    if (this.#jobs.has(batchId) || this.#draining) return;
    const controller = new AbortController();
    // The durable batch is authoritative after a crash; never leave the promise unhandled.
    const settled = this.#run(batchId, controller.signal).catch(() => {
      this.#uncertain = true;
    });
    this.#jobs.set(batchId, { controller, settled });
  }
  async #run(batchId: string, signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        if (signal.aborted) return;
        const next = nextBroadcastChild(this.#execution.store, batchId);
        if (next === null) return;
        const provider = this.#provider();
        if (!providerAdmits(provider, next.turn.bot)) {
          refuseBroadcastChild(this.#execution.store, batchId, next.turn.id);
          continue;
        }
        const admitted = admitBroadcastChild(this.#execution.store, batchId, next.turn.id);
        if (admitted.kind === 'closed') return;
        if (admitted.kind === 'refused') continue;
        const child = new AbortController();
        const abortChild = () => child.abort();
        signal.addEventListener('abort', abortChild, { once: true });
        if (signal.aborted) child.abort();
        this.#children.set(admitted.value.turn.taskRunId, child);
        try {
          const final = await executeChatTurn(this.#execution, {
            turn: admitted.value.turn,
            messages: admitted.value.messages,
            provider,
            signal: child.signal,
            emit: () => {},
          });
          if (final.status === 'uncertain') this.#uncertain = true;
        } catch {
          // The executor already persisted the conservative failure/uncertain phase.
          this.#uncertain = true;
        } finally {
          signal.removeEventListener('abort', abortChild);
          this.#children.delete(admitted.value.turn.taskRunId);
        }
        // An uncertain child keeps the room hold: pause for the explicit owner decision.
        if (pauseBroadcastIfUncertain(this.#execution.store, this.#clock, batchId)) return;
      }
    } finally {
      // Durable completion/failure is observable through the batch revision/document itself.
      settleBroadcastBatch(this.#execution.store, this.#clock, batchId);
      this.#jobs.delete(batchId);
    }
  }
}
