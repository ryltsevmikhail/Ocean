// Owner-only, fail-closed synthetic wire routing; real installed provider adapters and runtime.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { Buffer } from 'node:buffer';
const root = dirname(process.env.OCEAN_NATIVE_REQUESTS);
const record = (v) => appendFileSync(join(root, 'provider.jsonl'), JSON.stringify(v) + '\n');
const details = {
  format: 'gguf',
  family: 'qwen3',
  families: ['qwen3'],
  parameter_size: '2.0B',
  quantization_level: 'Q4_K_M',
};
const metadata = {
  '/models': {
    data: [
      { id: 'deepseek-flash', input_modalities: ['text', 'image'] },
      { id: 'deepseek-v4-pro', input_modalities: ['text'] },
    ],
  },
  '/api/version': { version: 'synthetic-e20' },
  '/api/tags': {
    models: [
      { name: 'qwen3:1.7b', model: 'qwen3:1.7b', digest: 'a'.repeat(64), size: 1024, details },
    ],
  },
  '/api/show': {
    details,
    capabilities: ['completion', 'tools'],
    model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 },
    tensors: [{ name: 'fixture', type: 'Q4_K', shape: [1] }],
  },
};
const server = createServer((req, res) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    record({ kind: 'wire', route: req.url, method: req.method });
    if (req.url in metadata) return res.end(JSON.stringify(metadata[req.url]));
    assert.ok(['/chat/completions', '/api/chat'].includes(req.url));
    const input = JSON.parse(body);
    record({ kind: 'generation', route: req.url, input });
    if (req.url === '/api/chat') {
      const deadline = Date.now() + 90000;
      while (!existsSync(join(root, 'release-b'))) {
        assert.ok(Date.now() < deadline);
        await delay(20);
      }
      res.end(
        JSON.stringify({
          model: input.model,
          message: { role: 'assistant', content: 'B done' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 1,
          eval_count: 1,
        }) + '\n',
      );
      return;
    }
    const tool = (name, args) => ({
      tool_calls: [
        {
          index: 0,
          id: name + '-fixture',
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    const task =
      input.tools?.some((t) => t.function.name === 'room_delegate') && body.includes('E20 task');
    const last = input.messages.at(-1);
    const serviceName = input.tools?.find((t) => t.function.name.startsWith('mcp_'))?.function.name;
    let delta = { content: 'Ordinary fixture answer' };
    if (task && !body.includes('B done'))
      delta = tool('room_delegate', {
        toBotId: readFileSync(join(root, 'bot-b'), 'utf8'),
        text: 'ask B',
      });
    else if (
      task &&
      serviceName &&
      !(last.role === 'tool' && String(last.content).includes('alpha'))
    )
      delta = tool(serviceName, { value: 'alpha' });
    else if (task) delta = { content: 'A done' };
    const finish_reason = delta.tool_calls ? 'tool_calls' : 'stop';
    res.setHeader('content-type', 'text/event-stream');
    res.end(
      [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
        .map((x) => 'data: ' + JSON.stringify(x) + '\n\n')
        .join('') + 'data: [DONE]\n\n',
    );
  })().catch((error) => {
    record({ kind: 'fixture-error', error: String(error) });
    res.destroy();
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
server.unref();
const endpoint = 'http://127.0.0.1:' + server.address().port;
writeFileSync(join(root, 'provider-endpoint'), endpoint);
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const text = String(url);
  if (text.startsWith('https://api.deepseek.com/'))
    return fetch(endpoint + text.slice('https://api.deepseek.com'.length), options);
  assert.ok(
    text.startsWith(endpoint + '/') || text.startsWith('http://127.0.0.1:'),
    'unexpected fixture network destination',
  );
  if (existsSync(join(root, 'local-unavailable')) && text === endpoint + '/api/chat') {
    record({ kind: 'local-unavailable', route: '/api/chat' });
    throw Error('synthetic local unavailable');
  }
  return fetch(url, options);
};
// Observe only exact owner decision votes. This never changes a frame or its result.
const { Socket } = await import('node:net');
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
      if (['decisions.resolve', 'roomTasks.start'].includes(frame.method)) {
        if (!requests.has(this)) requests.set(this, new Map());
        requests.get(this).set(frame.id, frame);
        appendFileSync(
          join(root, frame.method === 'decisions.resolve' ? 'votes.jsonl' : 'task-starts.jsonl'),
          JSON.stringify({ kind: 'request', frame }) + '\n',
        );
      }
    }
  }
  return emit.call(this, event, ...args);
};
const write = Socket.prototype.write;
Socket.prototype.write = function (chunk, ...rest) {
  if (Buffer.isBuffer(chunk) && chunk[0] === 123) {
    let response;
    try {
      response = JSON.parse(chunk);
    } catch {
      /* other protocol frame */
    }
    if (response && requests.get(this)?.has(response.id))
      appendFileSync(
        join(
          root,
          requests.get(this).get(response.id).method === 'decisions.resolve'
            ? 'votes.jsonl'
            : 'task-starts.jsonl',
        ),
        JSON.stringify({ kind: 'response', frame: response }) + '\n',
      );
  }
  return write.call(this, chunk, ...rest);
};
