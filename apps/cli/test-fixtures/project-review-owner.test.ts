import fs, { appendFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GitCodingApplyProject } from '@runnets/tools-node';
import { ProviderError, type ProviderPort } from '@runnets/application';
import type { HttpClient } from '@runnets/provider-core';
import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { serve } from './model-process-rpc.ts';

const [, , profile, mode] = process.argv;
if (mode === 'apply-crash' || mode === 'apply-file-failure') {
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (path) => {
    unlink(path);
    if (String(path).endsWith('.after')) {
      writeFileSync(join(profile!, 'apply-file-published'), 'published', { flush: true });
      if (mode === 'apply-file-failure') throw Error('scripted post-publication failure');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  };
  syncBuiltinESMExports();
}
let unblock: (() => void) | undefined;
let waiting: Promise<void> | undefined;
let beforeSend = false;
let transportUnknown = false;
if (mode?.startsWith('apply-before-claim')) {
  const inspect = GitCodingApplyProject.prototype.inspect;
  GitCodingApplyProject.prototype.inspect = async function (root) {
    const db = new DatabaseSync(join(profile!, 'runtime.sqlite'), { readOnly: true });
    let allowed;
    try {
      allowed = db
        .prepare(
          "SELECT 1 FROM ocean_owner_decisions WHERE decisionId LIKE 'coding-apply-%' AND status='allowed'",
        )
        .get();
    } finally {
      db.close();
    }
    if (allowed) {
      writeFileSync(join(profile!, 'apply-before-claim'), 'allowed', { flush: true });
      await waiting;
      if (mode === 'apply-before-claim-failure')
        throw Error('scripted post-allow Git inspection failure');
    }
    return inspect.call(this, root);
  };
}
const review = JSON.stringify({
  verdict: mode?.startsWith('apply') ? 'approve' : 'changes_requested',
  summary: 'Review of the captured artifact',
  findings: [{ path: 'file', side: 'after', line: 1, severity: 'minor', explanation: 'fixture' }],
});
const record = (data: unknown) =>
  appendFileSync(join(profile!, 'review-calls.jsonl'), JSON.stringify(data) + '\n', {
    flush: true,
  });
const http: HttpClient = {
  async send(request) {
    if (new URL(request.url).origin !== 'https://api.deepseek.com') throw Error('fixture origin');
    const metadata = JSON.stringify({
      data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    });
    if (request.method === 'GET')
      return {
        status: 200,
        ok: true,
        text: async () => metadata,
        stream: async function* () {
          yield metadata;
        },
      };
    const { model, messages, tools } = JSON.parse(request.body!);
    record({ model, messages, tools: tools ?? [] });
    return {
      status: 200,
      ok: true,
      text: async () => '',
      stream: async function* () {
        yield 'data: ' + JSON.stringify({ choices: [{ delta: { content: review } }] }) + '\n\n';
        yield 'data: ' +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
          '\n\n';
        yield 'data: ' +
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          }) +
          '\n\n';
        yield 'data: [DONE]\n\n';
      },
    };
  },
};
const provider: ProviderPort = {
  id: 'fixture',
  models: ['fixture'],
  capabilities: { streaming: true, usage: true, reasoning: false, toolCalls: true },
  async *stream(request) {
    if (beforeSend) {
      writeFileSync(join(profile!, 'review-before-send'), 'entered');
      await waiting;
    }
    if (request.authorizeDispatch?.() !== true)
      throw new ProviderError('invalid_request', 'refused', { dispatch: 'not_sent' });
    record({ messages: request.messages, tools: request.tools ?? [] });
    if (!beforeSend) await waiting;
    if (transportUnknown) {
      writeFileSync(join(profile!, 'review-stop-signal'), String(request.signal?.aborted === true));
      throw new ProviderError('cancelled', 'scripted transport stopped with outcome unknown', {
        dispatch: 'unknown',
      });
    }
    yield { type: 'text_delta', text: review };
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
  },
};
const host = await startLocalRuntime({
  profile: profile!,
  ...(mode === 'configured'
    ? { providerHttpClient: http, credentialDir: join(profile!, 'fixture-credentials') }
    : { provider }),
  ...(mode === 'drain'
    ? {
        drain: async () => {
          await waiting;
          return 'settled' as const;
        },
      }
    : {}),
  ...(mode === 'restore' ? { restore: true } : {}),
});
serve((method) => {
  if (method === 'hold' || method === 'hold-before-send') {
    beforeSend = method === 'hold-before-send';
    waiting = new Promise((resolve) => {
      unblock = resolve;
    });
  } else if (method === 'release' || method === 'release-unknown') {
    transportUnknown = method === 'release-unknown';
    unblock?.();
  } else if (method === 'stop') return host.stop();
  else if (method === 'status') return host.status();
  else throw Error('unknown fixture method');
  return null;
});
process.send!({ ready: host.identity });
