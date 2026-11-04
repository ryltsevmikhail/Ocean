import { localDesktopClient, type LocalDesktopClient } from './local-desktop-client.js';
import { localRestoreClient, type LocalRestoreClient } from './local-restore-client.js';
import { localProfileClient, type LocalProfileClient } from './local-profile-client.js';
import {
  localFinalizationClient,
  type LocalFinalizationClient,
} from './local-finalization-client.js';
import { localPanelClient, type LocalPanelClient } from './local-panel-client.js';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  LOCAL_RUNTIME_MAX_WAIT_MS,
  LOCAL_PLUGIN_SESSION_AUTHORITY,
  isLocalRuntimeIdentity,
  isLocalReceiptQuery,
  isLocalRunQuery,
  isLocalTurnRequest,
  isLocalTurnReceipt,
  isLocalRunSnapshot,
  type LocalTurnRequest,
  type LocalTurnReceipt,
  type LocalReceiptQuery,
  type LocalRunQuery,
  type LocalRunSnapshot,
  localRuntimeRecord,
  type LocalRuntimeIdentity,
  type LocalRuntimeStatus,
  type LocalRuntimeStop,
} from '@runnets/contracts';
import { readLocalRuntimeDescriptor } from './local-runtime-paths.js';
import { LocalRuntimeFrames, writeLocalRuntimeFrame } from './local-runtime-framing.js';
import { localRoomClient, validatedParams, type LocalRoomClient } from './local-room-client.js';
import { localDecisionClient, type LocalDecisionClient } from './local-decision-client.js';
import { localProviderClient, type LocalProviderClient } from './local-provider-client.js';
import { localBroadcastClient, type LocalBroadcastClient } from './local-broadcast-client.js';
import { localPluginClient, type LocalPluginClient } from './local-plugin-client.js';
export interface LocalRuntimeClient
  extends
    LocalRestoreClient,
    LocalDesktopClient,
    LocalProfileClient,
    LocalRoomClient,
    LocalDecisionClient,
    LocalPanelClient,
    LocalProviderClient,
    LocalBroadcastClient,
    LocalPluginClient,
    LocalFinalizationClient {
  readonly identity: LocalRuntimeIdentity;
  submit(request: LocalTurnRequest): Promise<LocalTurnReceipt>;
  getReceipt(query: LocalReceiptQuery): Promise<LocalTurnReceipt | null>;
  getRun(query: LocalRunQuery): Promise<LocalRunSnapshot | null>;
  status(): Promise<LocalRuntimeStatus>;
  stop(): Promise<LocalRuntimeStop>;
  close(): void;
}
class Peer {
  private readonly waiting = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
    const frames = new LocalRuntimeFrames((value) => {
      if (!localRuntimeRecord(value) || typeof value['id'] !== 'string')
        throw Error('invalid_frame');
      const pending = this.waiting.get(value['id']);
      if (!pending) throw Error('invalid_frame');
      this.waiting.delete(value['id']);
      clearTimeout(pending.timer);
      if (localRuntimeRecord(value['error']) && typeof value['error']['code'] === 'string')
        pending.reject(Error(value['error']['code']));
      else if ('result' in value) pending.resolve(value['result']);
      else {
        pending.reject(Error('invalid_frame'));
        throw Error('invalid_frame');
      }
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        frames.push(chunk);
      } catch {
        socket.destroy(Error('invalid_frame'));
      }
    });
    socket.on('error', () => this.rejectAll('runtime_unreachable'));
    socket.on('close', () => this.rejectAll('connection_closed'));
  }
  private rejectAll(code: string): void {
    for (const p of this.waiting.values()) {
      clearTimeout(p.timer);
      p.reject(Error(code));
    }
    this.waiting.clear();
  }
  request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(Error('connection_closed'));
    if (this.waiting.size >= 128) return Promise.reject(Error('client_busy'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(Error('runtime_timeout'));
        this.socket.destroy();
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      writeLocalRuntimeFrame(this.socket, { id, method, params });
    });
  }
  close(): void {
    this.socket.destroy();
  }
}
/** Connect only; absence/authentication failure never opens SQLite or spawns an owner. */
export async function connectLocalRuntime(options: {
  readonly profile: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<LocalRuntimeClient> {
  return connectDescriptor(readLocalRuntimeDescriptor(options.profile), options.signal);
}
/** Only an absent local publication permits an offline path. A peer cannot return this sentinel. */
export function connectPublishedRuntime(
  profile: string,
  signal?: AbortSignal,
): Promise<LocalRuntimeClient> | null {
  let descriptor;
  try {
    descriptor = readLocalRuntimeDescriptor(profile, true);
  } catch (e) {
    if (e instanceof Error && e.message === 'runtime_absent') return null;
    throw e;
  }
  return connectDescriptor(descriptor, signal);
}
async function connectDescriptor(
  descriptor: ReturnType<typeof readLocalRuntimeDescriptor>,
  signal?: AbortSignal,
): Promise<LocalRuntimeClient> {
  const socket = connect({
    path: descriptor.endpoint,
    ...(signal ? { signal } : {}),
  });
  const peer = new Peer(socket);
  try {
    const identity = await peer.request('hello', {
      ...descriptor,
      clientFeatures: [LOCAL_PLUGIN_SESSION_AUTHORITY],
    });
    if (
      !isLocalRuntimeIdentity(identity) ||
      identity.instanceId !== descriptor.instanceId ||
      identity.profileId !== descriptor.profileId
    )
      throw Error('identity_mismatch');
    if (
      identity.capabilities.some((capability) => capability.startsWith('plugin.')) &&
      !identity.capabilities.includes(LOCAL_PLUGIN_SESSION_AUTHORITY)
    )
      throw Error('plugin_runtime_upgrade_required');
    return {
      identity,
      ...localRestoreClient(peer.request.bind(peer)),
      ...localDesktopClient((method, params) => peer.request(method, params)),
      ...localProfileClient(peer.request.bind(peer)),
      ...localPanelClient(peer.request.bind(peer)),
      ...localDecisionClient(peer.request.bind(peer)),
      ...localFinalizationClient(peer.request.bind(peer)),
      ...localBroadcastClient((method, params) => peer.request(method, params)),
      ...localPluginClient((method, params, timeout) =>
        timeout === undefined
          ? peer.request(method, params)
          : peer.request(method, params, timeout),
      ),
      ...localProviderClient((method, params, timeout) =>
        timeout === undefined
          ? peer.request(method, params)
          : peer.request(method, params, timeout),
      ),
      ...localRoomClient(peer.request.bind(peer), identity),
      async submit(input) {
        const request = validatedParams(input, isLocalTurnRequest);
        const result = await peer.request('turns.submit', request);
        if (!matchesReceipt(result, request)) throw Error('invalid_frame');
        return result;
      },
      async getReceipt(input) {
        const query = validatedParams(input, isLocalReceiptQuery);
        const result = await peer.request('receipts.get', query);
        if (result !== null && !matchesReceipt(result, query)) throw Error('invalid_frame');
        return result;
      },
      async getRun(input) {
        const query = validatedParams(input, isLocalRunQuery);
        const result = await peer.request('runs.get', query);
        if (
          result !== null &&
          (!isLocalRunSnapshot(result) ||
            result.workspaceId !== query.workspaceId ||
            result.roomId !== query.roomId ||
            result.runId !== query.runId)
        )
          throw Error('invalid_frame');
        return result;
      },
      async status() {
        const value = await peer.request('status', {});
        if (
          !isLocalRuntimeIdentity(value) ||
          value.instanceId !== identity.instanceId ||
          value.profileId !== identity.profileId ||
          !localRuntimeRecord(value) ||
          !['ready', 'draining', 'stop_incomplete'].some((state) => state === value['state'])
        )
          throw Error('invalid_frame');
        return value as unknown as LocalRuntimeStatus;
      },
      async stop() {
        const value = await peer.request('stop', {}, LOCAL_RUNTIME_MAX_WAIT_MS);
        if (
          !localRuntimeRecord(value) ||
          value['instanceId'] !== identity.instanceId ||
          !(
            (value['state'] === 'stopped' && value['outcome'] === 'complete') ||
            (value['state'] === 'stop_incomplete' && value['outcome'] === 'uncertain')
          )
        )
          throw Error('invalid_frame');
        return value as unknown as LocalRuntimeStop;
      },
      close: () => peer.close(),
    };
  } catch (error) {
    peer.close();
    throw error;
  }
}

function matchesReceipt(value: unknown, query: LocalReceiptQuery): value is LocalTurnReceipt {
  return (
    isLocalTurnReceipt(value) &&
    value.requestId === query.requestId &&
    value.workspaceId === query.workspaceId &&
    value.roomId === query.roomId
  );
}
