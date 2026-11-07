import { AsyncLocalStorage } from 'node:async_hooks';

const active = new AsyncLocalStorage<InvocationSend>();

/** Binds one call's final writer and outcome across public SDK awaits. */
export class InvocationSend {
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  sent = false;
  httpStatus = 0;
  private closed = false;

  readonly id: string;
  readonly managedSession: string | undefined;
  readonly prepare: (() => Promise<void>) | undefined;
  private readonly authorize: (() => boolean) | undefined;
  constructor(
    timeoutMs: number,
    signal?: AbortSignal,
    id = '',
    authorize?: () => boolean,
    prepare?: () => Promise<void>,
    managedSession?: string,
  ) {
    this.id = id;
    this.prepare = prepare;
    this.managedSession = managedSession;
    this.authorize = authorize;
    this.deadline = performance.now() + timeoutMs;
    this.signal = signal;
  }

  static outside<T>(fn: () => T) {
    return active.exit(fn);
  }
  static get active() {
    return active.getStore();
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
    if (this.authorize && !this.authorize()) throw Error('dispatch denied');
    record?.();
    this.sent = true;
  }
}
