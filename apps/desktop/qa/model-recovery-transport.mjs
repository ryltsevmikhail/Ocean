// Synthetic owner-only faults/provider facts. Public dispatch, admission and persistence stay real.
import './model-native-transport.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { createHash } from 'node:crypto';
const root = dirname(process.env.OCEAN_NATIVE_REQUESTS);
const record = (name, value) => appendFileSync(join(root, name), JSON.stringify(value) + '\n');
function safe(input) {
  if (!input || typeof input !== 'object') return input;
  const { key, ...rest } = input;
  return key === undefined
    ? rest
    : { ...rest, keySha256: createHash('sha256').update(key).digest('hex') };
}
const requests = new WeakMap(),
  tails = new WeakMap();
const emit = Socket.prototype.emit,
  write = Socket.prototype.write;
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
Socket.prototype.write = function (chunk, ...rest) {
  if (Buffer.isBuffer(chunk) && chunk[0] === 123) {
    let response;
    try {
      response = JSON.parse(chunk);
    } catch {
      return write.call(this, chunk, ...rest);
    }
    const request = requests.get(this)?.get(response.id);
    if (
      request &&
      /^(modelConnections\.|bots\.setModelBinding|runs\.modelExecution)/.test(request.method)
    ) {
      record('rpc.jsonl', { method: request.method, input: safe(request.params), response });
      const control = join(root, 'fault.json');
      if (existsSync(control)) {
        const fault = JSON.parse(readFileSync(control, 'utf8'));
        if (
          fault.method === request.method &&
          (!fault.requestId || fault.requestId === request.params.requestId)
        ) {
          assert.ok(['drop', 'reply'].includes(fault.release));
          unlinkSync(control);
          record('held.jsonl', {
            method: request.method,
            input: safe(request.params),
            response,
            fault,
          });
          let timer, deadline;
          const release = () => {
            clearTimeout(timer);
            clearTimeout(deadline);
            if (fault.release === 'drop') this.destroy();
            else write.call(this, chunk, ...rest);
          };
          const poll = () => {
            if (this.destroyed) return;
            if (existsSync(join(root, 'release'))) {
              unlinkSync(join(root, 'release'));
              release();
            } else timer = setTimeout(poll, 20);
          };
          timer = setTimeout(poll, 20);
          deadline = setTimeout(() => {
            clearTimeout(timer);
            this.destroy();
          }, 10000);
          this.once('close', () => {
            clearTimeout(deadline);
            clearTimeout(timer);
          });
          return true;
        }
      }
    }
  }
  return write.call(this, chunk, ...rest);
};
const application = join(dirname(process.argv[1]), 'node_modules/@runnets/application');
const entry = JSON.parse(readFileSync(join(application, 'package.json'), 'utf8')).exports['.']
  .import;
const { ProviderActivationService, freezeModelActivation } = await import(
  pathToFileURL(join(application, entry))
);
const resolve = ProviderActivationService.prototype.resolve;
ProviderActivationService.prototype.resolve = function (...args) {
  const result = resolve.apply(this, args);
  if (!result.ok) return result;
  const modeFile = join(root, 'provider-mode');
  if (!existsSync(modeFile)) return result;
  const mode = readFileSync(modeFile, 'utf8');
  assert.ok(['actual', 'estimated', 'unavailable', 'held'].includes(mode));
  const provider = result.value.provider;
  // Fixture backend declares optional accounting before the real admission freezes it.
  const snapshot = freezeModelActivation({
    ...result.value.snapshot,
    capabilities: {
      ...result.value.snapshot.capabilities,
      usage: 'optional',
    },
  });
  return {
    ...result,
    value: {
      ...result.value,
      snapshot,
      provider: {
        id: provider.id,
        models: provider.models,
        capabilities: provider.capabilities,
        modelInfo: provider.modelInfo,
        async *stream(request) {
          record('provider.jsonl', { synthetic: true, mode, model: request.model });
          if (mode === 'held') {
            const deadline = Date.now() + 10000;
            while (!existsSync(join(root, 'provider-release'))) {
              assert.ok(Date.now() < deadline, 'synthetic provider hold timed out');
              await delay(20, null, { signal: request.signal });
            }
          }
          yield { type: 'text_delta', text: 'Synthetic usage ' + mode };
          if (mode !== 'unavailable')
            yield {
              type: 'usage_evidence',
              evidence: {
                kind: mode === 'estimated' ? 'estimated' : 'actual',
                tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                ...(mode === 'estimated' ? { estimator: 'synthetic-native' } : {}),
              },
            };
          yield { type: 'completed', stopReason: 'stop', rawStopReason: 'synthetic' };
        },
      },
    },
  };
};
