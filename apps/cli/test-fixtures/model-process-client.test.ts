import { connect } from 'node:net';
import {
  connectLocalRuntime,
  readLocalRuntimeDescriptor,
  LocalRuntimeFrames,
  writeLocalRuntimeFrame,
} from '@runnets/tools-node';
import { localRoomClient } from './rc2-room-client.ts';
import { isLocalRuntimeIdentity as rc2 } from './rc2-runtime-contract.ts';
import { serve } from './model-process-rpc.ts';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { LocalRuntimeIdentity } from '@runnets/contracts';
const profile = process.argv[2]!;
const mode = process.argv[3]!;
let raw: (method: string, params: unknown) => Promise<unknown>;
let identity: LocalRuntimeIdentity;
let client: Partial<LocalRuntimeClient>;
if (mode === 'sdk') {
  client = await connectLocalRuntime({ profile });
  identity = client.identity!;
  raw = async () => {
    throw Error('fixture_raw_on_sdk');
  };
} else {
  const d = readLocalRuntimeDescriptor(profile);
  const socket = connect(d.endpoint);
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  let n = 0;
  const decoder = new LocalRuntimeFrames((value) => {
    const frame = value as { id: string; result?: unknown; error?: { code: string } };
    const entry = pending.get(frame.id);
    if (!entry) throw Error('fixture_unknown_reply');
    pending.delete(frame.id);
    if (frame.error) entry.reject(Error(frame.error.code));
    else entry.resolve(frame.result);
  });
  socket.on('data', (b: Buffer) => decoder.push(b));
  socket.on('error', () => {});
  socket.on('close', () => {
    for (const p of pending.values()) p.reject(Error('connection_closed'));
    pending.clear();
  });
  raw = (method, params) =>
    new Promise((resolve, reject) => {
      const id = String(++n);
      pending.set(id, { resolve, reject });
      writeLocalRuntimeFrame(socket, { id, method, params });
    });
  const features =
    mode === 'rc2'
      ? undefined
      : mode === 'a3'
        ? ['plugin.session-authority-v1']
        : mode === 'model'
          ? ['model.connections-v1']
          : ['future.fixture-v99'];
  identity = (await raw('hello', {
    ...d,
    ...(features ? { clientFeatures: features } : {}),
  })) as LocalRuntimeIdentity;
  if ((mode === 'rc2' || mode === 'unknown') && !rc2(identity))
    throw Error('frozen_identity_refused');
  client = {
    ...localRoomClient(raw, identity),
    close: () => socket.destroy(),
    status: async () => {
      const value = await raw('status', {});
      if ((mode === 'rc2' || mode === 'unknown') && !rc2(value))
        throw Error('frozen_status_refused');
      return value as Awaited<ReturnType<LocalRuntimeClient['status']>>;
    },
  };
}
serve(async (method, input: { method: string; params: unknown }) => {
  if (method === 'raw') return raw(input.method, input.params);
  const fn = client[method as keyof LocalRuntimeClient];
  if (typeof fn !== 'function') throw Error('fixture_unknown_method');
  return (fn as (v: unknown) => unknown)(input);
});
process.send!({
  ready: { identity, pid: process.pid, sdk: import.meta.resolve('@runnets/tools-node') },
});
