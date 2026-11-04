import type { LocalBroadcastBatch, LocalRoomScope } from '@runnets/contracts';
import type { RoomConnection } from './room-connection.js';

/** One durable batch view shared by the TUI; every state comes from the runtime DTO. */
export class RemoteBroadcast {
  readonly #connection: RoomConnection;
  readonly #scope: LocalRoomScope;
  #latest: LocalBroadcastBatch | null = null;
  #pending: { requestId: string; text: string } | null = null;
  constructor(connection: RoomConnection, scope: LocalRoomScope) {
    this.#connection = connection;
    this.#scope = scope;
  }
  get latest() {
    return this.#latest;
  }
  async refresh() {
    const batches = await this.#connection.withClient((c) => c.broadcastList(this.#scope));
    this.#latest = batches[0] ?? null;
  }
  /** Stable per-batch status line for the TUI frame; children keep their frozen order. */
  status() {
    const batch = this.#latest;
    if (batch === null) return '';
    const children = [...batch.recipients]
      .sort((a, b) => a.position - b.position)
      .map((child) => `@${child.handle}:${child.state}`)
      .join(' ');
    return `всем ${batch.state} v${batch.revision} · ${children}`;
  }
  async submit(text: string) {
    const pending = this.#pending;
    if (pending && pending.text !== text)
      throw Error('Рассылка с другим текстом уже отправлялась; повторите исходный текст.');
    const request = (this.#pending ??= { requestId: crypto.randomUUID(), text });
    try {
      const batch = await this.#connection.withClient((c) =>
        c.broadcastSubmit({ ...this.#scope, requestId: request.requestId, text }),
      );
      this.#pending = null;
      this.#latest = batch;
      return batch;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (
        [
          'invalid_input',
          'invalid_params',
          'request_conflict',
          'workspace_conflict',
          'unknown_room',
          'batch_open',
          'runtime_draining',
          'provider_unavailable',
        ].includes(code)
      )
        this.#pending = null;
      throw error;
    }
  }
  async continue(batchId: string, expectedRevision: number) {
    this.#latest = await this.#connection.withClient((c) =>
      c.broadcastContinue({ ...this.#scope, batchId, expectedRevision }),
    );
    return this.#latest;
  }
  async abandon(batchId: string, expectedRevision: number) {
    this.#latest = await this.#connection.withClient((c) =>
      c.broadcastAbandon({ ...this.#scope, batchId, expectedRevision }),
    );
    return this.#latest;
  }
}
