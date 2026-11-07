import { expect, it } from 'vitest';
import { REQUEST_HARD_LIMIT_BYTES, ProviderError, type HttpClient } from '@runnets/provider-core';
import { createOpenAIProvider, OPENAI_MODELS, OPENAI_MODEL_INFO } from './index.js';
import { collect, fake, request, terminals } from '../test-fixtures/http.js';

it('sends the pinned raw profile once with an exact shared byte count', async () => {
  const { http, calls } = fake();
  const provider = createOpenAIProvider({ apiKey: 'fixture-key', httpClient: http, timeoutMs: 0 });
  const r = request({ maxTokens: 128000, temperature: 0.8 });
  const events = await collect(provider.stream(r));
  expect(terminals(events)).toEqual([
    { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    headers: { authorization: 'Bearer fixture-key' },
  });
  expect(JSON.parse(calls[0]!.body!)).toEqual({
    model: 'gpt-5.6-terra',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128000,
    store: false,
  });
  expect(provider.requestBytes!(r)).toBe(Buffer.byteLength(calls[0]!.body!, 'utf8'));
  expect(OPENAI_MODELS).toEqual(['gpt-5.6-terra']);
  expect(OPENAI_MODEL_INFO).toEqual([
    {
      id: 'gpt-5.6-terra',
      inputModalities: ['text', 'image'],
      contextTokens: 1050000,
      maxOutputTokens: 128000,
    },
  ]);
});
it('uses 4096 only for omission and honors small explicit limits', async () => {
  for (const value of [undefined, 1, 32768]) {
    const { http, calls } = fake();
    const provider = createOpenAIProvider({ apiKey: 'key', httpClient: http });
    await collect(provider.stream(request(value === undefined ? {} : { maxTokens: value })));
    expect(JSON.parse(calls[0]!.body!).max_completion_tokens).toBe(value ?? 4096);
  }
});
it.each([
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  128001,
  null as unknown as number,
])('refuses invalid output bound %s before send', async (maxTokens) => {
  const { http, calls } = fake();
  const provider = createOpenAIProvider({ apiKey: 'key', httpClient: http });
  expect(() => provider.requestBytes!(request({ maxTokens }))).toThrow();
  expect((await collect(provider.stream(request({ maxTokens })))).at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'invalid_request', dispatch: 'not_sent' },
  });
  expect(calls).toHaveLength(0);
});
it('refuses unsupported models, oversized requests and pre-aborted requests without dispatch', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const r of [
    request({ model: 'guessed-model' }),
    request({ messages: [{ role: 'user', content: 'x'.repeat(REQUEST_HARD_LIMIT_BYTES) }] }),
    request({ signal: controller.signal }),
  ]) {
    const { http, calls } = fake();
    const events = await collect(
      createOpenAIProvider({ apiKey: 'key', httpClient: http }).stream(r),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { dispatch: 'not_sent' } });
    expect(calls).toHaveLength(0);
  }
});
it.each([
  [401, 'auth'],
  [429, 'rate_limit'],
  [503, 'server'],
])('normalizes HTTP %s with one send and sanitized errors', async (status, code) => {
  const { http, calls } = fake(['sensitive-key and transcript'], status as number);
  const events = await collect(
    createOpenAIProvider({ apiKey: 'sensitive-key', httpClient: http }).stream(request()),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code, dispatch: 'unknown', status },
  });
  expect(JSON.stringify(events)).not.toContain('sensitive-key');
  expect(calls).toHaveLength(1);
});
it.each(['timeout', 'cancelled'])(
  'normalizes %s during read while retaining usage',
  async (kind) => {
    const controller = new AbortController();
    const http: HttpClient = {
      async send(r) {
        return {
          status: 200,
          ok: true,
          text: async () => '',
          async *stream() {
            yield 'data: {"model":"gpt-5.6-terra","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n';
            if (kind === 'cancelled') controller.abort();
            if (r.signal!.aborted) throw r.signal!.reason;
            await new Promise<void>((_resolve, reject) =>
              r.signal!.addEventListener('abort', () => reject(r.signal!.reason), { once: true }),
            );
          },
        };
      },
    };
    const events = await collect(
      createOpenAIProvider({
        apiKey: 'key',
        httpClient: http,
        timeoutMs: kind === 'timeout' ? 5 : 1000,
      }).stream(request({ signal: controller.signal })),
    );
    expect(events.at(-2)).toMatchObject({ type: 'usage', usage: { totalTokens: 7 } });
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: kind, dispatch: 'unknown' },
    });
    expect(terminals(events)).toHaveLength(1);
  },
);

it('captures one credential instead of rereading a mutable constructor object', async () => {
  const { http, calls } = fake();
  const options = { apiKey: 'original', httpClient: http };
  const provider = createOpenAIProvider(options);
  options.apiKey = 'replacement';
  await collect(provider.stream(request()));
  expect(calls[0]!.headers.authorization).toBe('Bearer original');
});

it('maps a non-Error caller abort reason to cancellation after dispatch', async () => {
  const abort = new AbortController();
  const http: HttpClient = {
    async send() {
      abort.abort('owner-request');
      throw Error('private transport detail');
    },
  };
  const events = await collect(
    createOpenAIProvider({ apiKey: 'key', httpClient: http }).stream(
      request({ signal: abort.signal }),
    ),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'cancelled', dispatch: 'unknown' },
  });
});

it('sanitizes typed transport failures and never inherits a pre-send claim after dispatch', async () => {
  let sends = 0;
  const http: HttpClient = {
    async send() {
      sends++;
      throw new ProviderError('network', 'private-key-and-transcript', { dispatch: 'not_sent' });
    },
  };
  const events = await collect(
    createOpenAIProvider({ apiKey: 'key', httpClient: http }).stream(request()),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'network', dispatch: 'unknown' },
  });
  expect(events.at(-1)).not.toMatchObject({ error: { message: 'private-key-and-transcript' } });
  expect(sends).toBe(1);
});
it.each([false, 'throw'] as const)('vetoes trusted dispatch %s before inference', async (mode) => {
  const f = fake();
  const p = createOpenAIProvider({ apiKey: 'fixture', httpClient: f.http });
  const events = await collect(
    p.stream(
      request({
        authorizeDispatch: () => {
          if (mode === 'throw') throw Error('veto');
          return false;
        },
      }),
    ),
  );
  expect(terminals(events)).toMatchObject([{ type: 'error', error: { dispatch: 'not_sent' } }]);
  expect(f.calls).toHaveLength(0);
});
