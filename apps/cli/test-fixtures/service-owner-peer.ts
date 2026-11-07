import { connect } from 'node:net';
import {
  LocalRuntimeFrames,
  readLocalRuntimeDescriptor,
  writeLocalRuntimeFrame,
} from '@runnets/tools-node';
export async function serviceOwnerPeer(profile: string, modern = true) {
  const descriptor = readLocalRuntimeDescriptor(profile);
  const socket = connect(descriptor.endpoint);
  let sequence = 0;
  let detached = false;
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const frames = new LocalRuntimeFrames((value) => {
    const frame = value as { id: string; result?: unknown; error?: { code: string } };
    const pending = waiting.get(frame.id);
    waiting.delete(frame.id);
    if (frame.error) pending?.reject(Error(frame.error.code));
    else pending?.resolve(frame.result);
  });
  socket.on('data', (b: Buffer) => frames.push(b));
  socket.on('error', () => {});
  socket.on('close', () => {
    if (!detached) for (const p of waiting.values()) p.reject(Error('peer_closed'));
    waiting.clear();
  });
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = String(++sequence);
      waiting.set(id, { resolve, reject });
      writeLocalRuntimeFrame(socket, { id, method, params });
    });
  try {
    await request('hello', {
      ...descriptor,
      clientFeatures: modern ? ['service.authority-v2'] : [],
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return {
    request,
    close: () => {
      detached = true;
      socket.destroy();
    },
  };
}
