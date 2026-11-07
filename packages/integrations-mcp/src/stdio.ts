import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { prepareManagedStdio } from '@runnets/tools-node';
import type { ServiceConnection } from '@runnets/domain';
import type { SessionWriter } from './session-writer.js';
import type {
  McpManagedSession,
  McpCleanupEvidence,
  McpServiceTransportOptions,
} from './contracts.js';

export async function serviceStdio(
  c: ServiceConnection,
  options: McpServiceTransportOptions,
  writer: SessionWriter,
  secret: string | null,
): Promise<{
  transport: StdioClientTransport;
  managed: McpManagedSession | null;
  lost(): void;
  prepareRetirement(): Promise<void>;
  cleanup(): Promise<McpCleanupEvidence>;
}> {
  const cfg = c.configuration;
  // The qualified offline profile has no credential channel.
  if (cfg.kind !== 'stdio' || secret || !options.stdio) throw Error('stdio not enrolled');
  const injected = options.stdio.workspaces?.[c.id];
  const workspace = cfg.workspaceRoot ?? injected;
  if (!workspace || (cfg.workspaceRoot && injected && cfg.workspaceRoot !== injected))
    throw Error('stdio enrollment conflict');
  const handle = await prepareManagedStdio({
    profileRoot: options.stdio.profileRoot,
    workspace,
    connectionId: c.id,
    artifact: cfg.executable,
    sha256: cfg.sha256,
    ...(cfg.packageJsonSha256 ? { packageJsonSha256: cfg.packageJsonSha256 } : {}),
    args: cfg.args,
    deadlineAt: writer.expiresAt,
    signal: AbortSignal.any([writer.lifetime, writer.discovery.signal]),
  });
  let lifetime: McpManagedSession['lifetime'] | undefined;
  let lost = false;
  const unavailable = new AbortController();
  try {
    if (cfg.workspaceRoot && options.prepareManagedLifetime)
      lifetime = await options.prepareManagedLifetime(c, handle);
    if (lifetime) {
      if (!/^[0-9a-f]{64}$/.test(lifetime.record.fingerprint))
        throw Error('managed lifetime identity missing');
      writer.managedSession = lifetime.record.fingerprint;
    }
  } catch (error) {
    await handle.cleanup();
    throw error;
  }
  class Managed extends StdioClientTransport {
    override async start() {
      if (
        Date.now() >= writer.expiresAt ||
        !lifetime ||
        !writer.discovery.authorizeMetadata() ||
        !handle.inspect() ||
        !lifetime.begin()
      )
        throw Error('launch denied');
      const closed = this.onclose,
        failed = this.onerror;
      this.onclose = () => {
        unavailable.abort();
        closed?.();
      };
      this.onerror = (error) => {
        unavailable.abort();
        failed?.(error);
      };
      const receive = this.onmessage;
      this.onmessage = (message) => {
        if (writer.discovering) {
          try {
            writer.countMetadata(Buffer.byteLength(JSON.stringify(message)));
          } catch {
            this.onerror?.(Error('metadata limit'));
            void this.close().catch(() => {});
            return;
          }
        }
        receive?.(message);
      };
      handle.start();
      await super.start();
      await handle.observe();
    }
    override async send(message: Parameters<StdioClientTransport['send']>[0]) {
      return writer.track(async () => {
        const method = 'method' in message ? message.method : 'response';
        const send = await writer.prepare(method);
        writer.admit(method, send);
        const signal = AbortSignal.any([
          writer.lifetime,
          unavailable.signal,
          ...(writer.discovering ? [writer.discovery.signal] : []),
        ]);
        signal.throwIfAborted();
        // Pinned SDK send writes once synchronously, then only waits for drain.
        // EOF/abort must end that wait; session retirement still joins SDK close,
        // all owned proof work and exact unit cleanup before settling its lifetime.
        return new Promise<void>((resolve, reject) => {
          const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(Error('stdio send interrupted'));
          };
          signal.addEventListener('abort', abort, { once: true });
          void super.send(message).then(
            () => {
              signal.removeEventListener('abort', abort);
              resolve();
            },
            (error: unknown) => {
              signal.removeEventListener('abort', abort);
              reject(error instanceof Error ? error : Error('stdio send failed'));
            },
          );
        });
      });
    }
  }
  const transport = new Managed(handle.parameters);
  // Never retain stderr. A flood ends the session and forces cgroup retirement.
  let bytes = 0;
  transport.stderr?.on('data', (chunk: Buffer) => {
    if ((bytes += chunk.length) > 65536 && writer.usable) {
      transport.onerror?.(Error('stderr limit'));
      void transport.close().catch(() => {});
    }
  });
  return {
    transport,
    managed: lifetime
      ? {
          handle,
          lifetime,
          signal: writer.lifetime,
          prepareResources: (work) => writer.ownResources(work),
        }
      : null,
    prepareRetirement: async () => {
      if (!(await handle.running())) lost = true;
    },
    lost: () => {
      lost = true;
    },
    cleanup: async () => {
      const status = await handle.cleanup();
      await lifetime?.finish(status, lost);
      return { status };
    },
  };
}
