import type { McpDiscoveryOptions, McpServiceTransportOptions } from './contracts.js';
import { InvocationSend } from './send.js';

/** No transport gets authority from an SDK connection or an AsyncLocalStorage token. */
export class SessionWriter {
  discovering = true;
  usable = true;
  transmitted = false;
  private metadataAttempts = 0;
  private metadataBytes = 0;
  readonly lifetime: AbortSignal;
  readonly discovery: McpDiscoveryOptions;
  readonly options: McpServiceTransportOptions;
  constructor(
    lifetime: AbortSignal,
    discovery: McpDiscoveryOptions,
    options: McpServiceTransportOptions,
  ) {
    this.lifetime = lifetime;
    this.discovery = discovery;
    this.options = options;
  }
  async prepare(method: string) {
    if (method !== 'tools/call') return undefined;
    const send = InvocationSend.current();
    await this.options.prepareDispatch?.(send.id);
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
