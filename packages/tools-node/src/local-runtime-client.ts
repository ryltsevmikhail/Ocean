import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
  LOCAL_RUNTIME_MAX_WAIT_MS,
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
export interface LocalRuntimeClient {
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
}): Promise<LocalRuntimeClient> {
  const descriptor = readLocalRuntimeDescriptor(options.profile);
  const socket = connect(descriptor.endpoint);
  const peer = new Peer(socket);
  try {
    const identity = await peer.request('hello', descriptor);
    if (
      !isLocalRuntimeIdentity(identity) ||
      identity.instanceId !== descriptor.instanceId ||
      identity.profileId !== descriptor.profileId
    )
      throw Error('identity_mismatch');
    return {
      identity,
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
          !['ready', 'draining', 'stop_incomplete'].includes(String(value['state']))
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

function validatedParams<T>(input: unknown, valid: (value: unknown) => value is T): T {
  if (!localRuntimeRecord(input)) throw Error('invalid_params');
  const snapshot = { ...input };
  if (!valid(snapshot)) throw Error('invalid_params');
  return snapshot;
}

function matchesReceipt(value: unknown, query: LocalReceiptQuery): value is LocalTurnReceipt {
  return (
    isLocalTurnReceipt(value) &&
    value.requestId === query.requestId &&
    value.workspaceId === query.workspaceId &&
    value.roomId === query.roomId
  );
}
