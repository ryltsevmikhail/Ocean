import { isLocalPanelChunk, PREVIEW_CHUNK, type LocalPanelChunk } from '@runnets/contracts';
import type { Runtime } from '../runtime.js';
import { codingPanelText } from '../ocean/coding-panel.js';
import { digest } from './decision-preview.js';
import type { RuntimeReply } from './queries.js';
type Frozen = {
  workspaceId: string;
  roomId: string;
  taskId: string;
  text: string;
  version: string;
};
const errors = new Set([
  'coding_denied',
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
  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }
  dispatch(p: Record<string, unknown>, signal: AbortSignal): RuntimeReply | Promise<RuntimeReply> {
    if (!isLocalPanelChunk(p)) return { error: { code: 'invalid_params' } };
    if (this.#draining) return { error: { code: 'runtime_draining' } };
    if (p.workspaceId !== 'ws_ocean') return { error: { code: 'coding_denied' } };
    if (p.offset > 0) {
      const f = this.#cache.get(signal);
      if (
        !f ||
        f.roomId !== p.roomId ||
        f.taskId !== p.taskId ||
        f.version !== p.version ||
        p.offset >= f.text.length
      )
        return { error: { code: 'stale_capture' } };
      if (p.offset + PREVIEW_CHUNK >= f.text.length) this.#cache.delete(signal);
      return this.#chunk(p, f);
    }
    if (this.#jobs.size >= 2) return { error: { code: 'query_limit' } };
    const job = this.#capture(p, signal);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job));
    return job;
  }
  async #capture(q: LocalPanelChunk, signal: AbortSignal): Promise<RuntimeReply> {
    try {
      const text = await codingPanelText(this.#runtime, q.roomId, q.taskId, 'inspect');
      if (signal.aborted) throw Error('observation_closed');
      const frozen = {
        workspaceId: q.workspaceId,
        roomId: q.roomId,
        taskId: q.taskId,
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
      return this.#chunk(q, frozen);
    } catch (e) {
      return {
        error: {
          code: e instanceof Error && errors.has(e.message) ? e.message : 'runtime_failure',
        },
      };
    }
  }
  #chunk(q: LocalPanelChunk, f: Frozen): RuntimeReply {
    return {
      result: {
        ...q,
        version: f.version,
        length: f.text.length,
        text: f.text.slice(q.offset, q.offset + PREVIEW_CHUNK),
      },
    };
  }
  async drain() {
    this.#draining = true;
    await Promise.all(this.#jobs);
    this.#cache.clear();
  }
}
