import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { prepareManagedStdio } from '@runnets/tools-node';
import type { ServiceConnection } from '@runnets/domain';
import type { SessionWriter } from './session-writer.js';
import type { McpCleanupEvidence, McpServiceTransportOptions } from './contracts.js';

export async function serviceStdio(
  c: ServiceConnection,
  options: McpServiceTransportOptions,
  writer: SessionWriter,
  secret: string | null,
): Promise<{ transport: StdioClientTransport; cleanup(): Promise<McpCleanupEvidence> }> {
  const cfg = c.configuration;
  // The qualified offline profile has no credential channel.
  if (
    cfg.kind !== 'stdio' ||
    secret ||
    !options.stdio ||
    !Object.hasOwn(options.stdio.workspaces, c.id)
  )
    throw Error('stdio not enrolled');
  const handle = await prepareManagedStdio({
    profileRoot: options.stdio.profileRoot,
    workspace: options.stdio.workspaces[c.id]!,
    connectionId: c.id,
    artifact: cfg.executable,
    sha256: cfg.sha256,
    ...(cfg.packageJsonSha256 ? { packageJsonSha256: cfg.packageJsonSha256 } : {}),
    args: cfg.args,
    signal: AbortSignal.any([writer.lifetime, writer.discovery.signal]),
  });
  class Managed extends StdioClientTransport {
    override async start() {
      if (!writer.discovery.authorizeMetadata()) throw Error('launch denied');
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
      const method = 'method' in message ? message.method : 'response';
      const send = await writer.prepare(method);
      writer.admit(method, send);
      return super.send(message);
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
  return { transport, cleanup: async () => ({ status: await handle.cleanup() }) };
}
