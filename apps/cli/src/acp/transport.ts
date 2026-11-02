/**
 * Newline-delimited JSON-RPC peer over a pair of streams.
 *
 * This is the transport half of the client boundary: it owns framing,
 * correlation and error responses, and nothing about the agent's semantics.
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  JSONRPC_ERROR,
  JSONRPC_VERSION,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from '@runnets/contracts';

export type RequestHandler = (params: unknown) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class JsonRpcPeer {
  readonly #output: Writable;
  readonly #requests = new Map<string, RequestHandler>();
  readonly #notifications = new Map<string, NotificationHandler>();
  readonly #pending = new Map<JsonRpcId, Pending>();
  /** Requests are served in arrival order so state-dependent methods cannot race. */
  #queue: Promise<void> = Promise.resolve();
  /** Methods that must be served immediately, even while another request runs. */
  readonly #concurrent = new Set<string>();
  #nextId = 0;
  #closed = false;

  constructor(options: { readonly input: Readable; readonly output: Writable }) {
    this.#output = options.output;
    const lines = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed !== '') this.#receive(trimmed);
    });
    lines.on('close', () => {
      this.#closed = true;
      for (const [id, pending] of this.#pending) {
        pending.reject(new Error(`transport closed before response to request ${String(id)}`));
      }
      this.#pending.clear();
    });
  }

  /** Wait for all state-changing requests accepted before input closed. */
  async drain(): Promise<void> {
    await this.#queue;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Register the handler for one client-initiated request method.
   *
   * `concurrent` exists for cancellation: it must reach the agent while a
   * streaming prompt is still being served, or it would queue behind it.
   */
  handle(method: string, handler: RequestHandler, options: { concurrent?: boolean } = {}): this {
    this.#requests.set(method, handler);
    if (options.concurrent === true) this.#concurrent.add(method);
    return this;
  }

  /** Register the handler for one client-initiated notification method. */
  onNotification(method: string, handler: NotificationHandler): this {
    this.#notifications.set(method, handler);
    return this;
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: JSONRPC_VERSION, method, params });
  }

  async request<TResult = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<TResult> {
    if (this.#closed) throw new Error('transport is closed');
    signal?.throwIfAborted();
    this.#nextId += 1;
    const id = this.#nextId;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    const abort = (): void => {
      this.#pending.get(id)?.reject(new Error('request cancelled'));
      this.#pending.delete(id);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) abort();
    else this.#write({ jsonrpc: JSONRPC_VERSION, id, method, params });
    try {
      return (await promise) as TResult;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  #write(message: JsonRpcMessage): void {
    this.#output.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.#write({
        jsonrpc: JSONRPC_VERSION,
        id: -1,
        error: { code: JSONRPC_ERROR.parse, message: 'malformed JSON frame' },
      });
      return;
    }

    if (isRequest(message)) {
      const { id, method, params } = message;
      if (this.#concurrent.has(method)) {
        void this.#serve(id, method, params);
      } else {
        this.#queue = this.#queue.then(() => this.#serve(id, method, params));
      }
      return;
    }
    if (isResponse(message)) {
      this.#settle(message);
      return;
    }
    if (isNotification(message)) {
      this.#notifications.get(message.method)?.(message.params);
    }
  }

  async #serve(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#requests.get(method);
    if (handler === undefined) {
      this.#write({
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: JSONRPC_ERROR.methodNotFound, message: `unknown method: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.#write({ jsonrpc: JSONRPC_VERSION, id, result });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? Number(error.code)
          : JSONRPC_ERROR.internal;
      this.#write({
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: Number.isFinite(code) ? code : JSONRPC_ERROR.internal,
          message: error instanceof Error ? error.message : 'internal error',
        },
      });
    }
  }

  #settle(message: JsonRpcResponse): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if ('error' in message) {
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      return;
    }
    pending.resolve(message.result);
  }
}
