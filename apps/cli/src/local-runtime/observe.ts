import { createHash, createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RoomRunReadPort } from '@runnets/application';
import {
  LOCAL_RUNTIME_MAX_PAGE,
  LOCAL_RUNTIME_MAX_FRAME,
  type RoomTaskRootView,
  type RoomTaskObserve,
  type RoomTaskObservation,
  type LocalObserveQuery,
  type LocalRoomObserveQuery,
  type LocalRoomObservation,
} from '@runnets/contracts';

/** Stateless authenticated watermarks. The observer holds no executor reference or buffered tokens. */
export class RuntimeObservers {
  readonly #key = randomBytes(32);
  readonly #read: RoomRunReadPort;
  readonly #instance: string;
  readonly #closed = new AbortController();
  #waiting = 0;
  readonly #peerWaits = new WeakMap<AbortSignal, number>();
  constructor(read: RoomRunReadPort, instance: string) {
    this.#read = read;
    this.#instance = instance;
  }
  close() {
    this.#closed.abort();
  }
  async observe(
    q: LocalObserveQuery | LocalRoomObserveQuery,
    detached: AbortSignal,
  ): Promise<LocalRoomObservation> {
    const run = 'runId' in q ? q : undefined;
    const room = { workspaceId: q.workspaceId, roomId: q.roomId };
    const deadline = performance.now() + (q.waitMs ?? 0);
    const signal = AbortSignal.any([detached, this.#closed.signal]);
    const sign = (position: string) =>
      createHmac('sha256', this.#key)
        .update(JSON.stringify([this.#instance, q.workspaceId, q.roomId, run?.runId, position]))
        .digest('base64url');
    let waiting = false;
    try {
      for (;;) {
        if (signal.aborted) throw Error('observation_closed');
        const snapshot = run ? this.#read.run(run) : null;
        if (run && !snapshot) throw Error('unknown_run');
        const roomSeq = this.#read.roomSequence(q);
        const projection = createHash('sha256')
          .update(
            JSON.stringify([
              snapshot?.turnStatus,
              snapshot?.pendingDecisionIds,
              run ? undefined : this.#read.decisionRevision?.(q),
            ]),
          )
          .digest('base64url');
        const version = snapshot?.version ?? 0;
        const mark = [version, roomSeq, projection].join('.');
        const cursor = mark + '.' + sign(mark);
        const result = {
          workspaceId: q.workspaceId,
          roomId: q.roomId,
          ...(snapshot ? { snapshot } : {}),
          roomSeq,
          cursor,
          instanceId: this.#instance,
        };
        if (q.cursor === undefined) return { ...result, kind: 'snapshot' };
        if (q.cursor !== cursor) {
          const parts = q.cursor.split('.');
          const oldVersion = Number(parts[0]),
            oldSeq = Number(parts[1]);
          const resumable =
            parts.length === 4 &&
            sign(parts.slice(0, 3).join('.')) === parts[3] &&
            oldVersion <= version &&
            oldSeq <= roomSeq &&
            version - oldVersion <= LOCAL_RUNTIME_MAX_PAGE &&
            roomSeq - oldSeq <= LOCAL_RUNTIME_MAX_PAGE &&
            this.#read.hasPositions(room, oldSeq, roomSeq) &&
            (!run || this.#read.hasPositions(run, oldVersion, version));
          return { ...result, kind: resumable ? 'changed' : 'resync' };
        }
        const ms = deadline - performance.now();
        if (ms <= 0) return { ...result, kind: 'timeout' };
        if (!waiting) {
          const peer = this.#peerWaits.get(detached) ?? 0;
          if (this.#waiting >= 32 || peer >= 4) throw Error('observer_busy');
          this.#peerWaits.set(detached, peer + 1);
          this.#waiting++;
          waiting = true;
        }
        await delay(Math.min(200, ms), undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw Error('observation_closed');
      throw error;
    } finally {
      if (waiting) {
        this.#waiting--;
        this.#peerWaits.set(detached, this.#peerWaits.get(detached)! - 1);
      }
    }
  }
  #rootHash(view: RoomTaskRootView): string {
    return createHash('sha256')
      .update(JSON.stringify([view, this.#read.decisionRevision?.(view)]))
      .digest('base64url');
  }
  rootPage(view: RoomTaskRootView, page?: string): RoomTaskRootView {
    const hash = this.#rootHash(view);
    let expires = Date.now() + 300000;
    const binding = ['root-page', this.#instance, view.workspaceId, view.roomId, view.rootId, hash];
    const sign = (body: string) => createHmac('sha256', this.#key).update(body).digest('base64url');
    const rowKey = (row: RoomTaskRootView['rows'][number]) => [
      row.type,
      row.type === 'slice' ? row.turnId : row.id,
    ];
    let offset = 0;
    if (page !== undefined) {
      try {
        const [body, signature] = page.split('.');
        if (!body || sign(body) !== signature) throw Error();
        const payload: unknown = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (
          !Array.isArray(payload) ||
          JSON.stringify(payload.slice(0, 6)) !== JSON.stringify(binding) ||
          payload.length !== 8 ||
          typeof payload[7] !== 'number' ||
          payload[7] <= Date.now()
        )
          throw Error();
        expires = payload[7];
        offset =
          view.rows.findIndex((r) => JSON.stringify(rowKey(r)) === JSON.stringify(payload[6])) + 1;
        if (offset < 1) throw Error();
      } catch {
        throw Error('resync_required');
      }
    }
    const rows: RoomTaskRootView['rows'][number][] = [];
    const result = () => {
      const last = rows.at(-1);
      const body = Buffer.from(
        JSON.stringify([...binding, last && rowKey(last), expires]),
      ).toString('base64url');
      return {
        ...view,
        rows,
        nextPage: offset + rows.length < view.rows.length ? body + '.' + sign(body) : null,
      };
    };
    for (const row of view.rows.slice(offset, offset + 50)) {
      rows.push(row);
      if (Buffer.byteLength(JSON.stringify(result())) > LOCAL_RUNTIME_MAX_FRAME - 1024) {
        rows.pop();
        break;
      }
    }
    if (!rows.length && offset < view.rows.length) throw Error('projection_too_large');
    return result();
  }
  async observeRoot(
    q: RoomTaskObserve,
    read: () => RoomTaskRootView,
    detached: AbortSignal,
  ): Promise<RoomTaskObservation> {
    const deadline = performance.now() + (q.waitMs ?? 0);
    const signal = AbortSignal.any([detached, this.#closed.signal]);
    const sign = (mark: string) =>
      createHmac('sha256', this.#key)
        .update(
          JSON.stringify(['root-observe', this.#instance, q.workspaceId, q.roomId, q.rootId, mark]),
        )
        .digest('base64url');
    let waiting = false;
    try {
      for (;;) {
        if (signal.aborted) throw Error('observation_closed');
        const full = read();
        const hash = this.#rootHash(full);
        const parts = q.cursor?.split('.') ?? [];
        const valid =
          parts.length === 3 &&
          parts[2] === sign(parts.slice(0, 2).join('.')) &&
          Number(parts[1]) > Date.now();
        const expires = valid ? parts[1]! : String(Date.now() + 300000);
        const mark = hash + '.' + expires;
        const cursor = mark + '.' + sign(mark);
        const result = { cursor, instanceId: this.#instance, view: this.rootPage(full) };
        if (q.cursor === undefined) return { ...result, kind: 'snapshot' };
        if (q.cursor !== cursor) {
          return { ...result, kind: valid ? 'changed' : 'resync' };
        }
        const ms = deadline - performance.now();
        if (ms <= 0) return { ...result, kind: 'timeout' };
        if (!waiting) {
          const peer = this.#peerWaits.get(detached) ?? 0;
          if (this.#waiting >= 32 || peer >= 4) throw Error('observer_busy');
          this.#peerWaits.set(detached, peer + 1);
          this.#waiting++;
          waiting = true;
        }
        await delay(Math.min(200, ms), undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) throw Error('observation_closed');
      throw error;
    } finally {
      if (waiting) {
        this.#waiting--;
        this.#peerWaits.set(detached, this.#peerWaits.get(detached)! - 1);
      }
    }
  }
}
