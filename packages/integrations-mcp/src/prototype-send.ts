import { AsyncLocalStorage } from 'node:async_hooks';

const active = new AsyncLocalStorage<InvocationSend>();

/** Binds one call's final writer and outcome across public SDK awaits. */
export class InvocationSend {
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  sent = false;
  httpStatus = 0;
  private closed = false;

  constructor(timeoutMs: number, signal?: AbortSignal) {
    this.deadline = performance.now() + timeoutMs;
    this.signal = signal;
  }

  static current(): InvocationSend {
    const invocation = active.getStore();
    if (!invocation) throw Error('missing business invocation');
    return invocation;
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await active.run(this, call);
    } finally {
      this.closed = true;
    }
  }

  /** Called synchronously after preparation, immediately before fetch or write. */
  admit(record?: () => void): void {
    if (this.closed || this.sent || this.signal?.aborted || performance.now() >= this.deadline)
      throw Error('invocation closed to dispatch');
    record?.();
    this.sent = true;
  }
}
