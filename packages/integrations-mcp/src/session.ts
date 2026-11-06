import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { canonicalJson, validServiceJson, type ServiceConnection } from '@runnets/domain';
import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  SERVICE_PLUGIN_MAX_REQUEST_BYTES,
  type ServiceCallInvocation,
  type ServicePluginInvokeOutcome,
} from '@runnets/application';
import { client } from './profile.js';
import type {
  McpCleanupEvidence,
  McpDiscoveryOptions,
  McpServiceTransportOptions,
} from './contracts.js';
import { listCatalog } from './catalog.js';
import { serviceHttp } from './http.js';
import { InvocationSend } from './send.js';
import { SessionWriter } from './session-writer.js';
import { serviceStdio } from './stdio.js';

function containsDecodedCredential(value: unknown, credential: string): boolean {
  if (typeof value === 'string') return value.includes(credential);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => key.includes(credential) || containsDecodedCredential(child, credential),
  );
}
function containsCredential(value: unknown, credential: string): boolean {
  // Scan the whole serialized literal once, then check keys and strings after JSON unescaping.
  return JSON.stringify(value).includes(credential) || containsDecodedCredential(value, credential);
}
export class Session {
  readonly stop = new AbortController();
  readonly writer: SessionWriter;
  readonly client: ReturnType<typeof client>;
  catalog: Awaited<ReturnType<typeof listCatalog>> | undefined;
  published: string | undefined;
  wasPublished = false;
  onLoss: (() => void) | undefined;
  private stdio: Awaited<ReturnType<typeof serviceStdio>> | undefined;
  get preparingStdio() {
    return this.connection.configuration.kind === 'stdio' && !this.stdio;
  }
  private secret: string | null = null;
  private retiring: Promise<McpCleanupEvidence> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private hint = false;
  private notified = false;
  private calls = 0;
  private drained: (() => void) | undefined;
  afterCalls() {
    return this.calls === 0
      ? Promise.resolve()
      : new Promise<void>((done) => {
          this.drained = done;
        });
  }
  readonly connection: ServiceConnection;
  readonly discovery: McpDiscoveryOptions;
  readonly options: McpServiceTransportOptions;
  constructor(
    connection: ServiceConnection,
    discovery: McpDiscoveryOptions,
    options: McpServiceTransportOptions,
  ) {
    this.connection = connection;
    this.discovery = discovery;
    this.options = options;
    this.writer = new SessionWriter(this.stop.signal, discovery, options);
    this.client = client(options.protocol === '2026-07-28');
    this.client.onclose = () => this.lost();
    this.client.onerror = () => this.lost();
    this.client.setNotificationHandler('notifications/tools/list_changed', () => this.refresh());
  }
  private lost() {
    if (!this.writer.usable) return;
    this.writer.usable = false;
    this.refresh();
    if (!this.writer.discovering) this.onLoss?.();
  }
  private refresh() {
    this.hint = true;
    if (this.published && !this.notified && !this.retiring) {
      this.notified = true;
      // This callback only schedules separate owner work. It cannot list inside a call.
      setImmediate(() =>
        InvocationSend.outside(() => {
          if (this.published && !this.stop.signal.aborted)
            this.options.refreshNeeded?.(this.connection.id);
        }),
      );
    }
  }
  deactivate() {
    this.published = undefined;
    clearTimeout(this.timer);
  }
  activate(id: string) {
    this.wasPublished = true;
    this.published = id;
    this.timer = setTimeout(() => this.refresh(), this.catalog!.ttlMs);
    this.timer.unref();
    if (this.hint) queueMicrotask(() => this.refresh());
  }
  async discover() {
    const c = this.connection,
      d = this.discovery;
    const signal = AbortSignal.any([this.stop.signal, d.signal]);
    if (signal.aborted || !d.authorizeMetadata()) throw Error('metadata denied');
    if (c.credentialReference) {
      const secret = this.options.resolveCredential?.(c.credentialReference, c);
      if (!secret || secret.length > 4096 || /[\r\n\0]/.test(secret))
        throw Error('credential unavailable');
      this.secret = secret;
    }
    const cfg = c.configuration;
    const transport =
      cfg.kind === 'http'
        ? serviceHttp(cfg.url, this.secret, this.options.githubIssueReadOnly === true, this.writer)
        : (this.stdio = await serviceStdio(c, this.options, this.writer, this.secret)).transport;
    signal.throwIfAborted();
    if (!d.authorizeMetadata()) throw Error('metadata denied');
    await this.client.connect(transport, { signal, timeout: d.deadlineMs });
    this.catalog = await listCatalog(this.client, c, signal, d.deadlineMs);
    if (this.secret && containsCredential(this.catalog.candidate, this.secret))
      throw Error('unsafe response');
    signal.throwIfAborted();
    if (!this.writer.usable || !d.authorizeMetadata()) throw Error('metadata denied');
    this.writer.discovering = false;
    return this.catalog.candidate;
  }
  async invoke(input: ServiceCallInvocation): Promise<ServicePluginInvokeOutcome> {
    const invocationId = input.invocationId;
    const refused = {
      kind: 'not_started',
      code: 'execution_disabled',
      invocationId,
      detail: 'session or dispatch unavailable',
    } as const;
    const c = this.connection,
      f = this.catalog;
    const tool = f?.full.get(input.definition.name);
    if (
      !f ||
      !tool ||
      !this.writer.usable ||
      this.published !== input.catalogId ||
      input.connection.currentCatalogId !== this.published ||
      input.connection.state !== 'active' ||
      input.connection.id !== c.id ||
      input.connection.credentialRevision !== c.credentialRevision ||
      input.connection.configRevision !== c.configRevision ||
      input.connection.trustRevision !== c.trustRevision ||
      input.connection.credentialReference !== c.credentialReference ||
      canonicalJson(input.connection.configuration) !== canonicalJson(c.configuration) ||
      canonicalJson(input.definition) !==
        canonicalJson(f.candidate.tools.find((t) => t.name === tool.name)) ||
      this.calls >= 16
    )
      return refused;
    const args = input.arguments;
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Buffer.byteLength(JSON.stringify(args)) > SERVICE_PLUGIN_MAX_REQUEST_BYTES
    )
      return refused;
    const timeout = Math.min(input.deadlineMs, SERVICE_PLUGIN_CALL_DEADLINE_MS);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || input.signal.aborted) return refused;
    const signal = AbortSignal.any([input.signal, this.stop.signal, AbortSignal.timeout(timeout)]);
    const send = new InvocationSend(timeout, signal, invocationId, () => input.authorizeDispatch());
    this.calls++;
    try {
      const reply = await send.run(() =>
        this.client.callTool(
          { name: tool.name, arguments: { ...args } },
          { signal, timeout, toolDefinition: tool },
        ),
      );
      if (!send.sent) return refused;
      if (!validServiceJson(reply) || (this.secret && containsCredential(reply, this.secret)))
        throw Error('unsafe response');
      return {
        kind: 'observed',
        invocationId,
        code: reply.isError ? 'vendor_error' : 'ok',
        vendorErrorCode: reply.isError ? 'tool_error' : null,
        result: reply,
      };
    } catch (error) {
      if (!send.sent) return refused;
      if (this.stdio && signal.aborted) this.lost();
      if (
        [400, 401, 403, 404].includes(send.httpStatus) ||
        (error instanceof ProtocolError && [-32020, -32022].includes(error.code)) ||
        (error instanceof SdkError && error.code === SdkErrorCode.UnsupportedResultType)
      )
        return {
          kind: 'observed',
          invocationId,
          code: 'vendor_error',
          result: null,
          vendorErrorCode: 'service_rejected',
        };
      return {
        kind: 'uncertain',
        invocationId,
        code: 'transport_failure',
        detail: 'no valid response after dispatch',
      };
    } finally {
      if (--this.calls === 0) this.drained?.();
    }
  }
  retire() {
    if (this.retiring) return this.retiring;
    this.writer.usable = false;
    this.deactivate();
    this.stop.abort();
    this.retiring = (async (): Promise<McpCleanupEvidence> => {
      let closed = true;
      try {
        await this.client.close();
      } catch {
        closed = false;
      }
      await this.writer.afterWork();
      const evidence = this.stdio
        ? await this.stdio.cleanup()
        : ({
            status: !closed ? 'unknown' : this.writer.transmitted ? 'confirmed' : 'never_started',
          } as const);
      this.secret = null;
      return evidence;
    })();
    return this.retiring;
  }
}
