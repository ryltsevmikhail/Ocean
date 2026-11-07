import { expect, it } from 'vitest';
import { collectReply, type HttpClient } from '@runnets/provider-core';
import { createLocalProvider, checkLocalModel } from './index.js';
import { endpoint, fixture, qualification, request, show, tags } from '../test-fixtures/http.js';
it.each([2147483648, 4294967296, Number.MAX_SAFE_INTEGER, -1, 1.5, NaN])(
  'refuses unsupported local deadline %s at construction',
  (timeoutMs) => {
    expect(() =>
      createLocalProvider({ endpoint, auth: { mode: 'none' }, qualification, timeoutMs }),
    ).toThrow(expect.objectContaining({ code: 'invalid_request', dispatch: 'not_sent' }));
  },
);
it.each([0, 2147483647])('accepts local supported timer boundary %s', (timeoutMs) => {
  expect(() =>
    createLocalProvider({ endpoint, auth: { mode: 'none' }, qualification, timeoutMs }),
  ).not.toThrow();
});
it.each([
  { '/api/version': { version: '' } },
  { '/api/version': { version: 'x'.repeat(129) } },
  { '/api/tags': { models: Array(4097).fill(tags.models[0]) } },
  { '/api/tags': { models: [tags.models[0], tags.models[0]] } },
  { '/api/show': { ...show, tensors: Array(16385).fill(show.tensors[0]) } },
  { '/api/show': { ...show, tensors: [{ name: 'x', type: 'Q4', shape: [0] }] } },
  { '/api/show': { ...show, tensors: [{ name: 'x', type: 'Q4', shape: Array(9).fill(1) }] } },
  { '/api/show': { ...show, tensors: [{ name: 'x'.repeat(513), type: 'Q4', shape: [1] }] } },
  { '/api/show': { ...show, capabilities: Array(33).fill('tools') } },
  { '/api/show': { ...show, remote_host: null } },
])('refuses bounded or malformed metadata %j', async (overrides) => {
  const f = fixture(overrides);
  await expect(
    checkLocalModel(
      { endpoint, auth: { mode: 'none' }, httpClient: f.http },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ dispatch: 'not_sent' });
  expect(f.requests.every((r) => !r.url.endsWith('/api/chat'))).toBe(true);
});
it.each([
  ['/api/version', 65537],
  ['/api/tags', 1048577],
  ['/api/show', 16777217],
] as const)('caps %s body before parsing without text reader', async (path, bytes) => {
  const f = fixture();
  const send = f.http.send.bind(f.http);
  f.http.send = async (r) =>
    r.url.endsWith(path)
      ? {
          ok: true,
          status: 200,
          text: async () => {
            throw Error('unbounded');
          },
          async *stream() {
            yield ' '.repeat(bytes);
          },
        }
      : send(r);
  await expect(
    checkLocalModel(
      { endpoint, auth: { mode: 'none' }, httpClient: f.http },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ dispatch: 'not_sent' });
});
it('shares one budget across metadata requests even when transport ignores its signal', async () => {
  const f = fixture();
  const send = f.http.send.bind(f.http);
  let n = 0;
  f.http.send = async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    n++;
    return send(r);
  };
  await expect(
    checkLocalModel(
      { endpoint, auth: { mode: 'none' }, httpClient: f.http, timeoutMs: 50 },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'timeout', dispatch: 'not_sent' });
  expect(n).toBeLessThan(3);
});
it('shares the inference deadline with preflight and never POSTs after caller cancellation', async () => {
  const controller = new AbortController();
  let sends = 0;
  const http: HttpClient = {
    async send() {
      sends++;
      controller.abort();
      return {
        ok: true,
        status: 200,
        text: async () => '',
        async *stream() {
          yield '{}';
        },
      };
    },
  };
  const reply = await collectReply(
    createLocalProvider({
      endpoint,
      auth: { mode: 'none' },
      qualification,
      httpClient: http,
      timeoutMs: 0,
    }).stream({ ...request, signal: controller.signal }),
  );
  expect(reply.error).toMatchObject({ code: 'cancelled', dispatch: 'not_sent' });
  expect(sends).toBe(1);
});
it('sanitizes malformed public qualification before returning a provider', () => {
  expect(() =>
    createLocalProvider({
      endpoint,
      auth: { mode: 'none' },
      qualification: { ...qualification, artifactDigest: 'secret invalid value' },
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid_request', dispatch: 'not_sent' }));
});
it.each(['cancelled', 'timeout'] as const)(
  'retains %s diagnostics after inference dispatch, with no tools',
  async (code) => {
    const f = fixture(),
      send = f.http.send.bind(f.http),
      controller = new AbortController();
    f.http.send = async (r) =>
      r.url.endsWith('/api/chat')
        ? {
            ok: true,
            status: 200,
            text: async () => '',
            async *stream() {
              yield JSON.stringify({
                done: false,
                message: {
                  role: 'assistant',
                  tool_calls: [{ function: { name: 'read', arguments: {} } }],
                },
              }) + '\n';
              if (code === 'cancelled') controller.abort();
              await new Promise(() => {});
            },
          }
        : send(r);
    const p = createLocalProvider({
      endpoint,
      auth: { mode: 'none' },
      qualification,
      httpClient: f.http,
      timeoutMs: code === 'timeout' ? 20 : 0,
    });
    const events = [];
    for await (const e of p.stream({ ...request, signal: controller.signal })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code, dispatch: 'unknown' } });
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  },
);
it.each(['malformed', 'unreachable'] as const)(
  'distinguishes %s metadata from transport failure',
  async (kind) => {
    const f = fixture(),
      send = f.http.send.bind(f.http);
    f.http.send = async (r) => {
      if (kind === 'unreachable' && r.url.endsWith('/api/tags'))
        throw Error('private transport details');
      if (kind === 'malformed' && r.url.endsWith('/api/version'))
        return {
          ok: true,
          status: 200,
          text: async () => '',
          async *stream() {
            yield '{';
          },
        };
      return send(r);
    };
    await expect(
      checkLocalModel(
        { endpoint, auth: { mode: 'none' }, httpClient: f.http },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: kind === 'malformed' ? 'invalid_request' : 'network',
      dispatch: 'not_sent',
    });
  },
);
