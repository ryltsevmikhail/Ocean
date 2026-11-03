import { codingRead } from './coding-reads.js';
import type { ProfileReads } from '@runnets/store-sqlite';
import {
  isLocalPanelChunk,
  isCodingChunk,
  MAX_PANEL_LENGTH,
  PREVIEW_CHUNK,
  type CodingReadMethod,
  type LocalPanelChunk,
  type LocalCodingRead,
} from '@runnets/contracts';
import type { Runtime } from '../runtime.js';
import { codingPanelText } from '../ocean/coding-panel.js';
import { digest } from './decision-preview.js';
import type { RuntimeReply } from './queries.js';
type Frozen = {
  key: string;
  text: string;
  version: string;
};
const errors = new Set([
  'coding_denied',
  'worktree_unavailable',
  'coding_unavailable',
  'unknown_coding_task',
  'changeset_limit',
  'unsupported_file',
  'stale_capture',
  'recovery_required',
  'observation_closed',
  'unknown_task',
]);
/** Keep at most two complete owner views, each scoped to its authenticated connection. */
export class CodingPanelQueries {
  readonly #runtime: Runtime;
  readonly #jobs = new Set<Promise<RuntimeReply>>();
  readonly #cache = new Map<AbortSignal, Frozen>();
  #draining = false;
  readonly #reads: ProfileReads;
  constructor(runtime: Runtime, reads: ProfileReads) {
    this.#reads = reads;
    this.#runtime = runtime;
  }
  dispatch(
    method: 'coding.panel' | CodingReadMethod,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): RuntimeReply | Promise<RuntimeReply> {
    const p: LocalPanelChunk | (LocalCodingRead & { offset: number; version?: string }) | null =
      method === 'coding.panel'
        ? isLocalPanelChunk(input)
          ? input
          : null
        : isCodingChunk(input)
          ? input
          : null;
    if (!p) return { error: { code: 'invalid_params' } };
    if (this.#draining) return { error: { code: 'runtime_draining' } };
    if (p.workspaceId !== 'ws_ocean') return { error: { code: 'coding_denied' } };
    const key = JSON.stringify([
      method,
      p.workspaceId,
      p.roomId ?? null,
      'taskId' in p ? p.taskId : p.id,
    ]);
    if (p.offset > 0) {
      const f = this.#cache.get(signal);
      if (!f || f.key !== key || f.version !== p.version || p.offset >= f.text.length)
        return { error: { code: 'stale_capture' } };
      if (p.offset + PREVIEW_CHUNK >= f.text.length) this.#cache.delete(signal);
      return this.#chunk(input, p.offset, f);
    }
    if (this.#jobs.size >= 2) return { error: { code: 'query_limit' } };
    const read = () =>
      method === 'coding.panel' && 'taskId' in p
        ? codingPanelText(this.#runtime, p.roomId, p.taskId, 'inspect')
        : method !== 'coding.panel' && 'id' in p
          ? codingRead(this.#runtime, this.#reads, method, p).then((value) => JSON.stringify(value))
          : Promise.reject(Error('invalid_params'));
    const job = this.#capture(input, key, read, signal);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job));
    return job;
  }
  async #capture(
    q: Record<string, unknown>,
    key: string,
    read: () => Promise<string>,
    signal: AbortSignal,
  ): Promise<RuntimeReply> {
    try {
      const text = await read();
      if (text.length > MAX_PANEL_LENGTH) throw Error('changeset_limit');
      if (signal.aborted) throw Error('observation_closed');
      const frozen = {
        key,
        text,
        version: digest(text),
      };
      if (text.length > PREVIEW_CHUNK) {
        if (!this.#cache.has(signal) && this.#cache.size >= 2) {
          const oldest = this.#cache.keys().next().value;
          if (oldest) this.#cache.delete(oldest);
        }
        this.#cache.set(signal, frozen);
      }
      return this.#chunk(q, 0, frozen);
    } catch (e) {
      return {
        error: {
          code: e instanceof Error && errors.has(e.message) ? e.message : 'runtime_failure',
        },
      };
    }
  }
  #chunk(q: Record<string, unknown>, offset: number, f: Frozen): RuntimeReply {
    return {
      result: {
        ...q,
        version: f.version,
        length: f.text.length,
        text: f.text.slice(offset, offset + PREVIEW_CHUNK),
      },
    };
  }
  async drain() {
    this.#draining = true;
    await Promise.all(this.#jobs);
    this.#cache.clear();
  }
}
