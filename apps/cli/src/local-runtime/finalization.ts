import { createHash, randomUUID } from 'node:crypto';
import {
  CodingFinalizationService,
  type CodingFinalizationStore,
  type RuntimeOwnerDecisions,
} from '@runnets/application';
import { isLocalFinalizationSelection, type LocalFinalizationResult } from '@runnets/contracts';
import { SqliteProjectLeases } from '@runnets/tools-node';
import type { RuntimeReply } from './queries.js';
/** Host-only finalization; confirmation still arrives through the common decisions channel. */
export class RuntimeFinalization {
  readonly #service: CodingFinalizationService;
  readonly #jobs = new Set<Promise<RuntimeReply>>();
  #closing = false;
  constructor(
    store: CodingFinalizationStore,
    owner: RuntimeOwnerDecisions,
    ownerId: string,
    epochId: string | null,
    restored: boolean,
    now: () => number = Date.now,
  ) {
    this.#service = new CodingFinalizationService({
      store,
      owner,
      leases: new SqliteProjectLeases(),
      ownerId,
      epochId,
      restored,
      clock: { now: () => new Date(now()) },
      nextId: randomUUID,
      digest: (text) => createHash('sha256').update(text).digest('hex'),
    });
  }
  dispatch(method: string, params: Record<string, unknown>): Promise<RuntimeReply> {
    if (this.#closing) return Promise.resolve({ error: { code: 'runtime_draining' } });
    if (this.#jobs.size >= 2) return Promise.resolve({ error: { code: 'query_limit' } });
    const job = this.#dispatch(method, params).finally(() => this.#jobs.delete(job));
    this.#jobs.add(job);
    return job;
  }
  async #dispatch(method: string, params: Record<string, unknown>): Promise<RuntimeReply> {
    try {
      if (!isLocalFinalizationSelection(params)) throw Error('invalid_params');
      if (method === 'coding.finalize.preview')
        return { result: await this.#service.preview(params, new AbortController().signal) };
      if (method === 'coding.finalize.result') {
        const result: LocalFinalizationResult = this.#service.result(params);
        return { result };
      }
      throw Error('invalid_params');
    } catch (error) {
      return {
        error: {
          code:
            error instanceof Error && /^[a-z_]+$/.test(error.message)
              ? error.message
              : 'finalization_unavailable',
        },
      };
    }
  }
  async drain(): Promise<'settled' | 'uncertain'> {
    this.#closing = true;
    try {
      // Abort the pending owner waiters so a held preview is durably refused
      // instead of making stop wait for the five-minute decision expiry.
      await this.#service.close();
      await Promise.all(this.#jobs);
      return 'settled';
    } catch {
      return 'uncertain';
    }
  }
}
