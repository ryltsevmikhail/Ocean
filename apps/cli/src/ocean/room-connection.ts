import { setTimeout as delay } from 'node:timers/promises';
import type { LocalRuntimeClient } from '@runnets/tools-node';

const transportErrors = new Set([
  'connection_closed',
  'runtime_timeout',
  'runtime_unreachable',
  'runtime_absent',
  'observer_busy',
]);
/** Share reconnection, but never regenerate the operation captured by a caller. */
export class RoomConnection {
  #peer: Promise<LocalRuntimeClient> | undefined;
  readonly #closed = new AbortController();
  readonly #connect: (signal: AbortSignal) => Promise<LocalRuntimeClient>;
  constructor(
    client: LocalRuntimeClient,
    connect: (signal: AbortSignal) => Promise<LocalRuntimeClient>,
  ) {
    this.#peer = Promise.resolve(client);
    this.#connect = connect;
  }
  get closed() {
    return this.#closed.signal.aborted;
  }
  async withClient<T>(operation: (c: LocalRuntimeClient) => Promise<T>): Promise<T> {
    for (;;) {
      this.#closed.signal.throwIfAborted();
      const connection = (this.#peer ??= this.#connect(this.#closed.signal));
      try {
        const client = await connection;
        this.#closed.signal.throwIfAborted();
        return await operation(client);
      } catch (error) {
        if (!(error instanceof Error && transportErrors.has(error.message)) || this.closed)
          throw error;
        if (error.message !== 'observer_busy' && this.#peer === connection) {
          this.#peer = undefined;
          void connection.then(
            (c) => c.close(),
            () => {},
          );
        }
        await delay(200, undefined, { signal: this.#closed.signal });
      }
    }
  }
  close() {
    this.#closed.abort();
    void this.#peer?.then(
      (c) => c.close(),
      () => {},
    );
  }
}
