import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import {
  localRuntimePaths,
  prepareLocalRuntimePaths,
  LocalRuntimeFrames,
  writeLocalRuntimeFrame,
} from '@runnets/tools-node';
import { serve } from './model-process-rpc.ts';
const profile = process.argv[2]!,
  mode = process.argv[3]!;
mkdirSync(profile, { mode: 0o700 });
const paths = localRuntimePaths(profile);
prepareLocalRuntimePaths(paths);
const descriptor = {
  protocol: 1,
  profileId: paths.profileId,
  instanceId: '11111111-1111-1111-1111-111111111111',
  endpoint: paths.endpoint,
  capability: 'a'.repeat(64),
};
const capabilities = [
  'status',
  'stop',
  ...(mode === 'safe'
    ? []
    : mode === 'a3'
      ? ['plugin.catalog', 'plugin.session-authority-v1']
      : ['plugin.catalog']),
];
const identity = {
  protocol: 1,
  profileId: paths.profileId,
  instanceId: descriptor.instanceId,
  capabilities,
};
const methods: string[] = [];
let features: unknown;
const server = createServer((socket) => {
  let authenticated = false;
  const frames = new LocalRuntimeFrames((value) => {
    const request = value as { id: string; method: string; params: Record<string, unknown> };
    methods.push(request.method);
    if (request.method === 'hello') {
      assert.equal(request.params['capability'], descriptor.capability);
      assert.equal(request.params['instanceId'], descriptor.instanceId);
      features = request.params['clientFeatures'];
      authenticated = true;
    } else assert.equal(authenticated, true);
    writeLocalRuntimeFrame(socket, {
      id: request.id,
      result:
        request.method === 'plugin.catalog'
          ? []
          : request.method === 'status'
            ? { ...identity, state: 'ready' }
            : identity,
    });
  });
  socket.on('data', (b: Buffer) => frames.push(b));
});
await new Promise<void>((resolve) => server.listen(paths.endpoint, resolve));
chmodSync(paths.endpoint, 0o600);
writeFileSync(paths.descriptor, JSON.stringify(descriptor), { mode: 0o600 });
serve(() => ({ methods, features }));
process.send!({ ready: { pid: process.pid, paths: import.meta.resolve('@runnets/tools-node') } });
