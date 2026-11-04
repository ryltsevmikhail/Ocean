import { expect, it } from 'vitest';
import { createAnthropicProvider } from './index.js';
import {
  collect,
  fake,
  request,
  start,
  delta,
  stop,
  tool,
  frame,
  terminals,
} from '../test-fixtures/http.js';
import type { HttpClient } from '@runnets/provider-core';
it.each(['', '   '])('refuses empty credential %s locally', (apiKey) => {
  expect(() => createAnthropicProvider({ apiKey })).toThrow('API key is empty');
});
it.each([-1, NaN, 1.1])('refuses invalid deadline %s', (timeoutMs) => {
  expect(() => createAnthropicProvider({ apiKey: 'key', timeoutMs })).toThrow();
});
it('pre-abort never sends or claims external cancellation', async () => {
  const f = fake();
  const signal = AbortSignal.abort();
  expect(
    await collect(
      createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request({ signal })),
    ),
  ).toMatchObject([{ type: 'error', error: { code: 'cancelled', dispatch: 'not_sent' } }]);
  expect(f.calls).toHaveLength(0);
});
it.each([301, 400, 401, 403, 429, 500, 529])(
  'sanitizes HTTP %s and makes one send',
  async (status) => {
    const f = fake(['private payload and key'], status);
    const events = await collect(
      createAnthropicProvider({ apiKey: 'private-key', httpClient: f.http }).stream(request()),
    );
    expect(terminals(events)).toMatchObject([
      { type: 'error', error: { status, dispatch: 'unknown' } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private/);
    expect(f.calls).toHaveLength(1);
  },
);
it('classifies a bounded explicit validation rejection without exposing vendor text', async () => {
  const f = fake(
    [
      '{"type":"error","error":{"type":"invalid_request_error","message":"missing workspace private"}}',
    ],
    400,
  );
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request()),
  );
  expect(terminals(events)).toMatchObject([
    {
      type: 'error',
      error: { code: 'invalid_request', status: 400, dispatch: 'rejected', retryable: false },
    },
  ]);
  expect(JSON.stringify(events)).not.toContain('private');
});
it.each(['send', 'body'])('enforces deadline on a stalled %s without retry', async (phase) => {
  let sends = 0;
  const httpClient: HttpClient = {
    async send() {
      sends++;
      if (phase === 'send') return new Promise(() => {});
      return {
        status: 200,
        ok: true,
        text: async () => '',
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
      };
    },
  };
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient, timeoutMs: 5 }).stream(request()),
  );
  expect(terminals(events)).toMatchObject([
    { type: 'error', error: { code: 'timeout', dispatch: 'unknown' } },
  ]);
  expect(sends).toBe(1);
});
it.each([false, true])(
  'abort after prefix/final accounting preserves only qualified actual (%s)',
  async (final) => {
    const controller = new AbortController();
    const httpClient: HttpClient = {
      async send() {
        return {
          status: 200,
          ok: true,
          text: async () => '',
          async *stream() {
            yield start();
            if (final) yield delta();
            controller.abort();
            yield stop;
          },
        };
      },
    };
    const events = await collect(
      createAnthropicProvider({ apiKey: 'key', httpClient }).stream(
        request({ signal: controller.signal }),
      ),
    );
    expect(events.some((e) => e.type === 'usage')).toBe(final);
    expect(terminals(events)).toMatchObject([
      { type: 'error', error: { code: 'cancelled', dispatch: 'unknown' } },
    ]);
  },
);
it('retains qualified final counts on in-stream failure and releases no tool', async () => {
  const f = fake([
    start(),
    ...tool(),
    delta('tool_use'),
    frame('error', { error: { type: 'overloaded_error', message: 'private' } }),
  ]);
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request()),
  );
  expect(events.filter((e) => e.type === 'usage')).toEqual([
    { type: 'usage', usage: { inputTokens: 200, outputTokens: 7, totalTokens: 207 } },
  ]);
  expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  expect(terminals(events)).toMatchObject([{ type: 'error', error: { dispatch: 'unknown' } }]);
});
it.each([
  frame('future_event'),
  frame('future_event', { tool: 'execute' }),
  frame('ping', { type: 'not_ping' }),
])('refuses unknown named events and malformed ping %#', async (event) => {
  const f = fake([start(), event, delta(), stop]);
  expect(
    terminals(
      await collect(
        createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request()),
      ),
    ),
  ).toMatchObject([{ type: 'error' }]);
});
it.each([
  [400, 'invalid_request_error'],
  [401, 'authentication_error'],
  [403, 'permission_error'],
] as const)(
  'accepts documented HTTP %s rejection with optional request ID',
  async (status, type) => {
    const f = fake(
      [
        JSON.stringify({
          type: 'error',
          error: { type, message: 'private' },
          request_id: 'req_fixture',
        }),
      ],
      status,
    );
    const events = await collect(
      createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request()),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { status, dispatch: 'rejected', retryable: false },
    });
    expect(JSON.stringify(events)).not.toContain('private');
  },
);
it.each([
  { usage: { output_tokens: 7 } },
  { message: { type: 'message' } },
  { content: [] },
  { future_metadata: true },
  { request_id: 42 },
])('mixed inference or unknown HTTP error envelope cannot prove rejection %#', async (extra) => {
  const f = fake(
    [
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'private' },
        ...extra,
      }),
    ],
    400,
  );
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request()),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { dispatch: 'unknown', retryable: false },
  });
});
it.each([
  { type: 'invalid_request_error' },
  { type: 'invalid_request_error', message: 42 },
  { type: 'invalid_request_error', message: 'private', usage: { output_tokens: 7 } },
])('malformed or expanded nested HTTP error cannot prove rejection %#', async (error) => {
  const f = fake([JSON.stringify({ type: 'error', error })], 400);
  expect(
    (
      await collect(
        createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request()),
      )
    ).at(-1),
  ).toMatchObject({ type: 'error', error: { dispatch: 'unknown' } });
});
