import type { McpDiscoveryOptions, McpServiceTransportOptions } from './contracts.js';
import type { ServiceResourceEvidence } from '@runnets/application';
import { InvocationSend } from './send.js';

/** No transport gets authority from an SDK connection or an AsyncLocalStorage token. */
export class SessionWriter {
  private readonly pending = new Set<Promise<unknown>>();
  track<T>(work: () => Promise<T>): Promise<T> {
    const promise = work();
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  ownResources(work: () => Promise<ServiceResourceEvidence>): Promise<ServiceResourceEvidence> {
    let ready!: (value: ServiceResourceEvidence) => void, fail!: (error: unknown) => void;
    const result = new Promise<ServiceResourceEvidence>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    void this.track(async () => {
      try {
        const evidence = await work();
        let release!: () => void, closing: Promise<void> | undefined;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        ready({
          facts: evidence.facts,
          inspect: () => evidence.inspect(),
          close: () =>
            (closing ??= (async () => {
              try {
                await evidence.close();
              } finally {
                release();
              }
            })()),
        });
        await released;
      } catch (error) {
        fail(error);
      }
    }).catch(() => {});
    return result;
  }
  async afterWork(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  managedSession: string | null = null;
  discovering = true;
  usable = true;
  transmitted = false;
  private metadataAttempts = 0;
  private metadataBytes = 0;
  readonly expiresAt: number;
  readonly lifetime: AbortSignal;
  readonly discovery: McpDiscoveryOptions;
  readonly options: McpServiceTransportOptions;
  constructor(
    lifetime: AbortSignal,
    discovery: McpDiscoveryOptions,
    options: McpServiceTransportOptions,
  ) {
    this.expiresAt = Date.now() + discovery.deadlineMs;
    this.lifetime = lifetime;
    this.discovery = discovery;
    this.options = options;
  }
  async prepare(method: string) {
    if (method !== 'tools/call') return undefined;
    const send = InvocationSend.current();
    if (this.managedSession !== null && send.managedSession !== this.managedSession)
      throw Error('managed generation evidence missing');
    await this.options.prepareDispatch?.(send.id);
    await send.prepare?.();
    return send;
  }
  admit(method: string, send: InvocationSend | undefined) {
    this.lifetime.throwIfAborted();
    if (!this.usable) throw Error('session unavailable');
    if (send) {
      if (this.discovering) throw Error('not activated');
      send.admit();
      return;
    }
    if (
      InvocationSend.active ||
      !this.discovering ||
      !['initialize', 'server/discover', 'notifications/initialized', 'GET', 'tools/list'].includes(
        method,
      ) ||
      ++this.metadataAttempts > 20 ||
      this.discovery.signal.aborted ||
      !this.discovery.authorizeMetadata()
    )
      throw Error('metadata denied');
    this.transmitted = true;
  }
  countMetadata(bytes: number) {
    if ((this.metadataBytes += bytes) > 4 * 1024 * 1024) throw Error('metadata bytes exceeded');
  }
}
