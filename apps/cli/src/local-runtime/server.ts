import { timingSafeEqual } from 'node:crypto';
import { type Socket } from 'node:net';
import type { EndpointLayout } from './endpoint-files.js';
import { bindListener } from './listener.js';
import {
  clientFeatures,
  clientIdentity,
  supportsPlugins,
  type RuntimeWireContext,
} from './client-compatibility.js';
import {
  isLocalRuntimeRequest,
  LOCAL_MODEL_METHODS,
  LOCAL_ROOM_TASKS,
  LOCAL_ROOM_TASK_LIST,
  LOCAL_CODING_WORKSPACE,
  isCodingWorkspaceRead,
  LOCAL_SERVICE_AUTHORITY,
  LOCAL_MODEL_CONNECTIONS,
  LOCAL_SERVICE_CONFIRMATIONS,
  LOCAL_ADDRESSED_HISTORY,
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
    let services = false;
    let context: RuntimeWireContext = Object.freeze({ models: false });
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
        services = features.includes(LOCAL_SERVICE_AUTHORITY);
        context = Object.freeze({
          models: features.includes(LOCAL_MODEL_CONNECTIONS),
          serviceConfirmations: features.includes(LOCAL_SERVICE_CONFIRMATIONS),
          addressedHistory: features.includes(LOCAL_ADDRESSED_HISTORY),
          codingWorkspace:
            features.includes(LOCAL_CODING_WORKSPACE) &&
            operations.identity.capabilities.includes(LOCAL_CODING_WORKSPACE),
          roomTaskList:
            features.includes(LOCAL_ROOM_TASK_LIST) &&
            features.includes(LOCAL_ROOM_TASKS) &&
            features.includes(LOCAL_ADDRESSED_HISTORY) &&
            operations.identity.capabilities.includes(LOCAL_ROOM_TASKS) &&
            operations.identity.capabilities.includes(LOCAL_ROOM_TASK_LIST) &&
            operations.identity.capabilities.includes(LOCAL_ADDRESSED_HISTORY),
          roomTasks:
            features.includes(LOCAL_ROOM_TASKS) &&
            features.includes(LOCAL_ADDRESSED_HISTORY) &&
            operations.identity.capabilities.includes(LOCAL_ROOM_TASKS),
        });
        authenticated = true;
        clearTimeout(handshakeTimeout);
        writeLocalRuntimeFrame(socket, {
          id,
          result: clientIdentity(
            operations.identity,
            plugins,
            context.models,
            services,
            context.serviceConfirmations,
            context.addressedHistory,
            context.roomTasks,
            context.roomTaskList,
            context.codingWorkspace,
          ),
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
          result: clientIdentity(
            operations.status(),
            plugins,
            context.models,
            services,
            context.serviceConfirmations,
            context.addressedHistory,
            context.roomTasks,
            context.roomTaskList,
            context.codingWorkspace,
          ),
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
      if (method === 'roomTasks.list' && !context.roomTaskList) {
        reject('client_upgrade_required');
        return;
      }
      if (
        (isCodingWorkspaceRead(method) || method === 'coding.tasks.reserve') &&
        !context.codingWorkspace
      ) {
        reject('client_upgrade_required');
        return;
      }
      if (method.startsWith('roomTasks.') && !context.roomTasks) {
        reject('client_upgrade_required');
        return;
      }
      if (method.startsWith('service.') && !services) {
        reject('service_runtime_upgrade_required');
        return;
      }
      if (method.startsWith('plugin.') && !plugins) {
        reject('plugin_runtime_upgrade_required');
        return;
      }
      if (LOCAL_MODEL_METHODS.some((m) => m === method) && !context.models) {
        reject('model_runtime_upgrade_required');
        return;
      }
      if (pending >= 128) {
        socket.destroy();
        return false;
      }
      try {
        const reply = operations.dispatch(method, params, detached.signal, context);
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
