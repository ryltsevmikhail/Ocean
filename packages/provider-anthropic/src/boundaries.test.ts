import { expect, it } from 'vitest';
import { createAnthropicProvider, probeAnthropicModels } from './index.js';
import { REQUEST_HARD_LIMIT_BYTES, type HttpClient, type ImagePart } from '@runnets/provider-core';
import { collect, fake, request, start, delta, stop, frame } from '../test-fixtures/http.js';
it('rejects body over the shared hard gate without dispatch', async () => {
  const f = fake();
  const p = createAnthropicProvider({ apiKey: 'key', httpClient: f.http });
  const r = request({
    messages: [{ role: 'user', content: 'x'.repeat(REQUEST_HARD_LIMIT_BYTES) }],
  });
  expect(p.requestBytes!(r)).toBeGreaterThan(REQUEST_HARD_LIMIT_BYTES);
  expect(await collect(p.stream(r))).toMatchObject([
    { type: 'error', error: { code: 'invalid_request', dispatch: 'not_sent' } },
  ]);
  expect(f.calls).toHaveLength(0);
});
it.each(['system', 'assistant', 'tool'] as const)(
  'refuses image content in %s role before send',
  async (role) => {
    const f = fake();
    const image: ImagePart = {
      type: 'image',
      mediaType: 'image/png',
      bytes: new Uint8Array([1]),
      attachmentId: 'a',
      roomId: 'r',
      sha256: 'hash',
      width: 1,
      height: 1,
    };
    const events = await collect(
      createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(
        request({ messages: [{ role, content: [image] }] }),
      ),
    );
    expect(events).toMatchObject([{ type: 'error', error: { dispatch: 'not_sent' } }]);
    expect(f.calls).toHaveLength(0);
  },
);
it('preserves cancellation while reading bounded validation error evidence', async () => {
  const controller = new AbortController();
  const httpClient: HttpClient = {
    async send() {
      return {
        ok: false,
        status: 400,
        text: async () => '',
        async *stream() {
          controller.abort();
          yield 'private';
        },
      };
    },
  };
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient }).stream(
      request({ signal: controller.signal }),
    ),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'cancelled', dispatch: 'unknown' },
  });
});
it('unbounded HTTP validation bodies cannot prove rejection', async () => {
  const f = fake(['x'.repeat(65537)], 400);
  expect(
    (
      await collect(
        createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request()),
      )
    ).at(-1),
  ).toMatchObject({ type: 'error', error: { status: 400, dispatch: 'unknown' } });
});
it('sanitizes network exceptions without asserting rejection or retrying', async () => {
  let sends = 0;
  const httpClient: HttpClient = {
    async send() {
      sends++;
      throw Error('secret key and transcript');
    },
  };
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient }).stream(request()),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'network', dispatch: 'unknown' },
  });
  expect(JSON.stringify(events)).not.toMatch(/secret|transcript/);
  expect(sends).toBe(1);
});
it('caller abort terminates a stalled metadata reader', async () => {
  const controller = new AbortController();
  const httpClient: HttpClient = {
    async send() {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => {
              controller.abort();
              return new Promise(() => {});
            },
          }),
        }),
      };
    },
  };
  expect(await probeAnthropicModels({ apiKey: 'key', httpClient }, controller.signal)).toEqual({
    outcome: 'cancelled',
    httpStatus: 200,
    models: [],
  });
});
it.each([
  frame('content_block_delta', {
    index: 0,
    delta: { type: 'signature_delta', signature: 'signed' },
  }),
  frame('content_block_start', { index: -1, content_block: { type: 'text', text: '' } }),
])('refuses unsupported deltas and invalid indices %#', async (bad) => {
  const f = fake([start(), bad, delta(), stop]);
  const events = await collect(
    createAnthropicProvider({ apiKey: 'key', httpClient: f.http }).stream(request()),
  );
  expect(events.some((e) => e.type === 'completed' || e.type === 'tool_call')).toBe(false);
});
