import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
const script = `
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import process from 'node:process';
const root = process.env.FAULT_ROOT;
process.argv[1] = join(process.cwd(), 'apps/cli/qa-owner.js');
await import(process.env.FAULT_HOOK);
const server = createServer(socket => {
  let data = '';
  socket.on('data', chunk => {
    data += chunk;
    if (!data.endsWith('\\n')) return;
    const request = JSON.parse(data);
    socket.write(Buffer.from(JSON.stringify({ id: request.id, result: { revision: 2, requestId: request.params.requestId } }) + '\\n'));
  });
});
await new Promise(resolve => server.listen(join(root, 'socket'), resolve));
writeFileSync(join(root, 'fault.json'), JSON.stringify({ method: 'modelConnections.set', release: process.env.FAULT_MODE === 'deadline' ? 'drop' : process.env.FAULT_MODE }));
const socket = connect(join(root, 'socket'));
await new Promise(resolve => socket.once('connect', resolve));
let received = '';
socket.on('data', b => { received += b; });
const closed = new Promise(resolve => socket.once('close', resolve));
const frame = JSON.stringify({ id: 'wire-id', method: 'modelConnections.set', params: {
  requestId: 'original', expectedRevision: 1, defaultModelId: 'model', key: 'synthetic-only',
} }) + '\\n';
socket.write(frame.slice(0, 20));
await delay(10);
socket.write(frame.slice(20));
for (let i = 0; i < 100 && !existsSync(join(root, 'held.jsonl')); i++) await delay(10);
assert.ok(existsSync(join(root, 'held.jsonl')));
assert.equal(received, '');
const held = JSON.parse(readFileSync(join(root, 'held.jsonl'), 'utf8'));
assert.equal(held.input.requestId, 'original');
assert.equal(held.input.expectedRevision, 1);
assert.equal(held.input.defaultModelId, 'model');
assert.match(held.input.keySha256, /^[a-f0-9]{64}$/);
assert.ok(!JSON.stringify(held).includes('synthetic-only'));
if (process.env.FAULT_MODE !== 'deadline') writeFileSync(join(root, 'release'), '');
if (process.env.FAULT_MODE === 'reply') {
  for (let i = 0; i < 100 && !received; i++) await delay(10);
  assert.equal(JSON.parse(received).result.revision, 2);
  // The hold deadline must retire after release, not kill a healthy socket later.
  await delay(10100);
  assert.equal(socket.destroyed, false);
  socket.destroy();
}
await closed;
assert.equal(received === '', process.env.FAULT_MODE !== 'reply');
await new Promise(resolve => server.close(resolve));
`;
for (const mode of ['reply', 'drop', 'deadline']) {
  test(
    'committed synthetic reply: ' + mode + ', fragmented input and keyless retained identity',
    { timeout: 18000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), 'oa-fault-'));
      try {
        const result = spawnSync(process.execPath, ['--input-type=module'], {
          input: script,
          encoding: 'utf8',
          timeout: 16000,
          env: {
            ...process.env,
            OCEAN_NATIVE_REQUESTS: join(root, 'requests.jsonl'),
            FAULT_ROOT: root,
            FAULT_MODE: mode,
            FAULT_HOOK: resolve(import.meta.dirname, 'model-recovery-transport.mjs'),
          },
        });
        assert.equal(result.status, 0, result.stderr + String(result.error ?? ''));
        assert.equal(readFileSync(join(root, 'rpc.jsonl'), 'utf8').trim().split('\n').length, 1);
      } finally {
        rmSync(root, { recursive: true });
      }
    },
  );
}
