import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync } from 'node:fs';
import {
  isLocalRuntimeRequest,
  type LocalRuntimeDescriptor,
  type LocalRuntimeIdentity,
  type LocalRuntimeStatus,
  type LocalRuntimeStop,
} from '@runnets/contracts';
import { LocalRuntimeFrames, writeLocalRuntimeFrame } from '@runnets/tools-node';
export interface LifecycleOperations {
  readonly descriptor: LocalRuntimeDescriptor;
  readonly identity: LocalRuntimeIdentity;
  status(): LocalRuntimeStatus;
  stop(): Promise<LocalRuntimeStop>;
}
/** This server exposes lifecycle only. Execution and owner decisions are not RPCs yet. */
export async function listenLocalRuntime(
  operations: LifecycleOperations,
): Promise<{ server: Server; clients: Set<Socket> }> {
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    if (clients.size >= 64) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    let authenticated = false;
    let stopping = false;
    const handshakeTimeout = setTimeout(() => socket.destroy(), 5000);
    const frames = new LocalRuntimeFrames((value) => {
      if (stopping) return;
      if (!isLocalRuntimeRequest(value)) {
        socket.destroy();
        return;
      }
      const { id, method, params } = value;
      const reject = (code: string) => {
        writeLocalRuntimeFrame(socket, { id, error: { code } });
      };
      if (method === 'hello' && !authenticated) {
        if (params['protocol'] !== 1) {
          reject('protocol_mismatch');
          stopping = true;
          socket.end();
          return;
        }
        const capability = params['capability'];
        if (
          params['profileId'] !== operations.identity.profileId ||
          params['instanceId'] !== operations.identity.instanceId ||
          typeof capability !== 'string' ||
          !/^[a-f0-9]{64}$/.test(capability) ||
          !timingSafeEqual(Buffer.from(capability), Buffer.from(operations.descriptor.capability))
        ) {
          reject('authentication_failed');
          stopping = true;
          socket.end();
          return;
        }
        authenticated = true;
        clearTimeout(handshakeTimeout);
        writeLocalRuntimeFrame(socket, { id, result: operations.identity });
        return;
      }
      if (!authenticated) {
        reject('authentication_required');
        stopping = true;
        socket.end();
        return;
      }
      if (Object.keys(params).length !== 0) {
        reject('invalid_params');
        return;
      }
      if (method === 'status') {
        writeLocalRuntimeFrame(socket, { id, result: operations.status() });
        return;
      }
      if (method === 'stop') {
        stopping = true;
        void operations
          .stop()
          .then((result) => {
            writeLocalRuntimeFrame(socket, { id, result });
            socket.end();
          })
          .catch(() => {
            reject('stop_incomplete');
            socket.end();
          });
        return;
      }
      reject('method_not_found');
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        frames.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(handshakeTimeout);
      clients.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const error = (e: Error) => reject(e);
    server.once('error', error);
    server.listen(operations.descriptor.endpoint, () => {
      server.off('error', error);
      resolve();
    });
  });
  chmodSync(operations.descriptor.endpoint, 0o600);
  return { server, clients };
}
