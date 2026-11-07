import { connect } from 'node:net';
import {
  LocalRuntimeFrames,
  readLocalRuntimeDescriptor,
  writeLocalRuntimeFrame,
} from '@runnets/tools-node';
import type {
  LocalRuntimeIdentity,
  LocalRuntimeStatus,
  LocalRuntimeResponse,
} from '@runnets/contracts';
/** Synthetic profile-only raw socket, used to emulate independent RC2/A3/B negotiations. */
export async function modelWire(profile: string, features: readonly string[]) {
  const descriptor = readLocalRuntimeDescriptor(profile);
  const socket = connect(descriptor.endpoint);
  let next = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const frames = new LocalRuntimeFrames((raw) => {
    const reply = raw as LocalRuntimeResponse;
    const request = pending.get(reply.id);
    if (!request) throw Error('unknown_reply');
    pending.delete(reply.id);
    if ('error' in reply) request.reject(Error(reply.error.code));
    else request.resolve(reply.result);
  });
  socket.on('data', (bytes) => frames.push(bytes));
  socket.on('error', () => {});
  socket.on('close', () => {
    for (const p of pending.values()) p.reject(Error('connection_closed'));
    pending.clear();
  });
  const send = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = String(++next);
      pending.set(id, { resolve, reject });
      writeLocalRuntimeFrame(socket, { id, method, params });
    });
  const identity = (await send('hello', {
    ...descriptor,
    clientFeatures: features,
  })) as LocalRuntimeIdentity;
  return {
    identity,
    send,
    status: () => send('status', {}) as Promise<LocalRuntimeStatus>,
    close: () => {
      socket.destroy();
    },
  };
}
