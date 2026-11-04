import { timingSafeEqual } from 'node:crypto';
import { type Socket } from 'node:net';
import type { EndpointLayout } from './endpoint-files.js';
import { bindListener } from './listener.js';
import { clientFeatures, clientIdentity, supportsPlugins } from './client-compatibility.js';
import {
  isLocalRuntimeRequest,
  type LocalRuntimeDescriptor,
  type LocalRuntimeIdentity,
  type LocalRuntimeStatus,
  type LocalRuntimeStop,
} from '@runnets/contracts';
import { LocalRuntimeFrames, writeLocalRuntimeFrame } from '@runnets/tools-node';
import type { RuntimeTurns } from './turns.js';
export interface LifecycleOperations {
  readonly descriptor: LocalRuntimeDescriptor;
  readonly identity: LocalRuntimeIdentity;
  readonly dispatch: RuntimeTurns['dispatch'];
  status(): LocalRuntimeStatus;
  stop(): Promise<LocalRuntimeStop>;
}
/** Authenticate before dispatch. The connection owns only its bounded pending responses. */
export async function listenLocalRuntime(operations: LifecycleOperations, layout: EndpointLayout) {
  const clients = new Set<Socket>();
  const { server, socketFd, activate } = await bindListener(layout, (socket) => {
    if (clients.size >= 64) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    const detached = new AbortController();
    let authenticated = false;
    let plugins = false;
    let stopping = false;
    let pending = 0;
    const handshakeTimeout = setTimeout(() => socket.destroy(), 5000);
    const frames = new LocalRuntimeFrames((value) => {
      if (stopping || socket.destroyed) return false;
      if (!isLocalRuntimeRequest(value)) {
        socket.destroy();
        return false;
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
        const features = clientFeatures(params);
        if (features === null) {
          reject('invalid_params');
          stopping = true;
          socket.end();
          return;
        }
        plugins = supportsPlugins(features);
        authenticated = true;
        clearTimeout(handshakeTimeout);
        writeLocalRuntimeFrame(socket, {
          id,
          result: clientIdentity(operations.identity, plugins),
        });
        return;
      }
      if (!authenticated) {
        reject('authentication_required');
        stopping = true;
        socket.end();
        return;
      }
      if ((method === 'status' || method === 'stop') && Object.keys(params).length !== 0) {
        reject('invalid_params');
        return;
      }
      if (method === 'status') {
        writeLocalRuntimeFrame(socket, {
          id,
          result: clientIdentity(operations.status(), plugins),
        });
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
      if (method.startsWith('plugin.') && !plugins) {
        reject('plugin_runtime_upgrade_required');
        return;
      }
      if (pending >= 128) {
        socket.destroy();
        return false;
      }
      try {
        const reply = operations.dispatch(method, params, detached.signal);
        if (reply instanceof Promise) {
          pending++;
          void reply
            .then((value) => {
              if (!socket.destroyed && !socket.writableEnded)
                writeLocalRuntimeFrame(socket, { id, ...value });
            })
            .catch(() => {
              if (!socket.destroyed && !socket.writableEnded) reject('runtime_failure');
            })
            .finally(() => {
              pending--;
            });
        } else writeLocalRuntimeFrame(socket, { id, ...reply });
      } catch {
        reject('runtime_failure');
      }
      return;
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
      detached.abort();
      clients.delete(socket);
    });
  });
  return { server, clients, socketFd, activate };
}
