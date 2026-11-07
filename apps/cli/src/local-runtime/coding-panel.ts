import { codingRead, codingSnapshotAccess, codingSnapshotSummary } from './coding-reads.js';
import type { ProfileReads } from '@runnets/store-sqlite';
import {
  isLocalPanelChunk,
  isCodingChangesetCapture,
  isCodingChangesetMethod,
  isCodingChangesetChunk,
  isCodingChangesetSummary,
  type CodingChangesetCapture,
  type LocalPanelChunk,
  type LocalCodingRead,
  type CodingChangesetMethod,
  isCodingChunk,
  MAX_PANEL_LENGTH,
  PREVIEW_CHUNK,
  type CodingReadMethod,
} from '@runnets/contracts';
import type { Runtime } from '../runtime.js';
import { codingPanelText } from '../ocean/coding-panel.js';
import { digest } from './decision-preview.js';
import type { RuntimeReply } from './queries.js';
type PanelMethod = 'coding.panel' | CodingReadMethod | CodingChangesetMethod;
export const isCodingPanelMethod = (method: string): method is PanelMethod =>
  isCodingChangesetMethod(method) ||
  method === 'coding.panel' ||
  method === 'coding.diff' ||
  method === 'coding.show' ||
  method === 'coding.inspect-apply';
type Frozen = {
  key: string;
  text: string;
  version: string;
};
const errors = new Set([
  'coding_denied',
  'request_conflict',
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
  readonly #captures = new Map<string, { binding: string; job: Promise<RuntimeReply> }>();
  readonly #cache = new Map<AbortSignal, Frozen>();
  #draining = false;
  readonly #reads: ProfileReads;
  constructor(runtime: Runtime, reads: ProfileReads) {
    this.#reads = reads;
    this.#runtime = runtime;
  }
  dispatch(
    method: PanelMethod,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): RuntimeReply | Promise<RuntimeReply> {
    if (method === 'coding.changesets.capture') {
      if (!isCodingChangesetCapture(input)) return { error: { code: 'invalid_params' } };
      if (this.#draining) return { error: { code: 'runtime_draining' } };
      if (input.workspaceId !== 'ws_ocean') return { error: { code: 'coding_denied' } };
      return this.#publish(input);
    }
    const exact =
      method === 'coding.changesets.read' && isCodingChangesetChunk(input) ? input : null;
    const p: LocalPanelChunk | (LocalCodingRead & { offset: number; version?: string }) | null =
      method === 'coding.panel'
        ? isLocalPanelChunk(input)
          ? input
          : null
        : method === 'coding.changesets.read'
          ? exact
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
      exact?.hash,
    ]);
    if (p.offset > 0) {
      const f = this.#cache.get(signal);
      if (!f || f.key !== key || f.version !== p.version || p.offset >= f.text.length)
        return { error: { code: 'stale_capture' } };
      if (exact) {
        try {
          codingSnapshotAccess(this.#runtime, exact);
        } catch (error) {
          return this.#error(error);
        }
      }
      if (p.offset + PREVIEW_CHUNK >= f.text.length) this.#cache.delete(signal);
      return this.#chunk(input, p.offset, f);
    }
    if (this.#jobs.size >= 2) return { error: { code: 'query_limit' } };
    const read = async () => {
      if (exact) {
        const access = codingSnapshotAccess(this.#runtime, exact);
        const result = this.#runtime.codingChanges.read(access, exact.hash);
        if (!result.ok) throw Error(result.error.code);
        return JSON.stringify({
          ...codingSnapshotSummary(exact, result.value),
          diff: result.value.diff,
        });
      }
      if (method === 'coding.panel' && 'taskId' in p)
        return codingPanelText(this.#runtime, p.roomId, p.taskId, 'inspect');
      if (method !== 'coding.panel' && method !== 'coding.changesets.read' && 'id' in p)
        return JSON.stringify(await codingRead(this.#runtime, this.#reads, method, p));
      throw Error('invalid_params');
    };
    const job = this.#capture(input, key, read, signal);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job));
    return job;
  }
  #publish(q: CodingChangesetCapture): RuntimeReply | Promise<RuntimeReply> {
    let access;
    try {
      access = codingSnapshotAccess(this.#runtime, q);
    } catch (error) {
      return this.#error(error);
    }
    const key = 'owner-capture-' + digest(JSON.stringify([q.workspaceId, q.requestId]));
    const binding = JSON.stringify(access);
    const previous = this.#captures.get(key);
    if (previous)
      return previous.binding === binding ? previous.job : { error: { code: 'request_conflict' } };
    if (this.#jobs.size >= 2) return { error: { code: 'query_limit' } };
    const job = this.#runtime.codingChanges
      .capture(access, key)
      .then((value) => {
        if (!value.ok) return { error: { code: value.error.code } };
        const result = codingSnapshotSummary(q, value.value);
        return isCodingChangesetSummary(result)
          ? { result }
          : { error: { code: 'runtime_failure' } };
      })
      .catch((error: unknown) => this.#error(error));
    this.#captures.set(key, { binding, job });
    this.#jobs.add(job);
    void job.finally(() => {
      this.#captures.delete(key);
      this.#jobs.delete(job);
    });
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
      return this.#error(e);
    }
  }
  #error(error: unknown): RuntimeReply {
    return {
      error: {
        code:
          error instanceof Error && errors.has(error.message) ? error.message : 'runtime_failure',
      },
    };
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
