// Synthetic HTTP and one lost chat receipt only; installed owner admission/state stay real.
import './model-native-transport.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
const root = dirname(process.env.OCEAN_NATIVE_REQUESTS);
const record = (name, data) => appendFileSync(join(root, name), JSON.stringify(data) + '\n');
const metadata = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== 'https://api.deepseek.com/chat/completions') return metadata(url, options);
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body);
  const parts = body.messages.at(-1).content;
  const text = Array.isArray(parts) ? parts.map((p) => p.text ?? '').join('\n') : parts;
  const images = Array.isArray(parts) ? parts.filter((p) => p.type === 'image_url') : [];
  record('provider.jsonl', { synthetic: true, model: body.model, text, images });
  if (text.startsWith('held-')) {
    const release = join(root, 'release-' + text);
    const deadline = Date.now() + 60000;
    while (!existsSync(release)) {
      assert.ok(Date.now() < deadline, 'synthetic provider hold expired');
      await setTimeout(20, null, { signal: options.signal });
    }
  }
  const chunks = [
    { choices: [{ delta: { content: 'Synthetic handoff: ' + text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ];
  return new globalThis.Response(
    chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
};
const requests = new WeakMap(),
  tails = new WeakMap();
const emit = Socket.prototype.emit;
Socket.prototype.emit = function (event, ...args) {
  if (event === 'data' && Buffer.isBuffer(args[0])) {
    const lines = ((tails.get(this) ?? '') + args[0].toString()).split('\n');
    tails.set(this, lines.pop());
    for (const line of lines) {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.method) {
        if (!requests.has(this)) requests.set(this, new Map());
        requests.get(this).set(frame.id, frame);
      }
    }
  }
  return emit.call(this, event, ...args);
};
const write = Socket.prototype.write;
Socket.prototype.write = function (chunk, ...rest) {
  if (Buffer.isBuffer(chunk) && chunk[0] === 123) {
    const response = JSON.parse(chunk);
    const request = requests.get(this)?.get(response.id);
    if (request?.method === 'turns.submit' && response.result?.messageId) {
      record('submissions.jsonl', { input: request.params, receipt: response.result });
      record('receipts.jsonl', response.result);
      const drop = join(root, 'drop-chat');
      if (existsSync(drop)) {
        unlinkSync(drop);
        record('dropped.jsonl', response.result);
        this.destroy();
        return false;
      }
    }
  }
  return write.call(this, chunk, ...rest);
};
