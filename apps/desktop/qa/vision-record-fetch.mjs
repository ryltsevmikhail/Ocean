/* eslint-disable no-undef -- Node globals in the isolated runtime child. */
// Loaded only by the isolated live-acceptance runtime child.
// Records the exact serialized vendor request bodies for private wire evidence;
// it never reads, logs or writes the Authorization header.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const dir = process.env.OCEAN_RECORD_DIR;
if (typeof dir !== 'string' || !dir.startsWith('/tmp/')) throw Error('record_dir_missing');
mkdirSync(dir + '/requests', { recursive: true, mode: 0o700 });
const original = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = String(init.method ?? (input instanceof Request ? input.method : 'GET'));
  if (!url.endsWith('/chat/completions') || method !== 'POST') return original(input, init);
  const id = randomUUID();
  const body = typeof init.body === 'string' ? init.body : '';
  writeFileSync(dir + '/requests/' + id + '.json', body, { mode: 0o600, flag: 'wx' });
  appendFileSync(
    dir + '/calls.jsonl',
    JSON.stringify({ id, state: 'sent', bytes: Buffer.byteLength(body) }) + '\n',
    { mode: 0o600 },
  );
  const started = Date.now();
  const response = await original(input, init);
  appendFileSync(
    dir + '/calls.jsonl',
    JSON.stringify({
      id,
      state: 'response',
      status: response.status,
      durationMs: Date.now() - started,
    }) + '\n',
    { mode: 0o600 },
  );
  return response;
};
