import { expect, it } from 'vitest';
import { checkLocalModel, createLocalProvider } from './index.js';
import { collectReply } from '@runnets/provider-core';
import { endpoint, fixture, qualification, request, show, tags } from '../test-fixtures/http.js';
it('qualifies exact local metadata without auth and records requested context, not capacity', async () => {
  const f = fixture();
  expect(
    await checkLocalModel(
      { endpoint, auth: { mode: 'none' }, httpClient: f.http },
      new AbortController().signal,
    ),
  ).toEqual(qualification);
  expect(
    f.requests.map((r) => [
      new URL(r.url).pathname,
      r.method,
      r.redirect,
      r.headers['authorization'],
    ]),
  ).toEqual([
    ['/api/version', 'GET', 'manual', undefined],
    ['/api/tags', 'GET', 'manual', undefined],
    ['/api/show', 'POST', 'manual', undefined],
  ]);
  expect(JSON.parse(f.requests[2]!.body!)).toEqual({ model: 'qwen3:1.7b', verbose: true });
});
it.each([
  { '/api/tags': { models: [] } },
  { '/api/tags': { models: [{ ...tags.models[0], digest: '8f68893c685c' }] } },
  { '/api/show': { ...show, tensors: [] } },
  { '/api/show': { ...show, remote_model: 'cloud-model' } },
  { '/api/show': { ...show, capabilities: ['tools'] } },
  { '/api/show': { ...show, details: { ...show.details, quantization_level: 'Q8_0' } } },
  {
    '/api/show': {
      ...show,
      model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 2048 },
    },
  },
])('refuses absent/unknown/contradictory model evidence before inference %j', async (override) => {
  const f = fixture(override);
  await expect(
    checkLocalModel(
      { endpoint, auth: { mode: 'none' }, httpClient: f.http },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ dispatch: 'not_sent' });
  expect(f.requests.some((r) => r.url.endsWith('/api/chat'))).toBe(false);
});
it.each([
  { '/api/version': { version: 'drift' } },
  { '/api/tags': { models: [{ ...tags.models[0], digest: 'b'.repeat(64) }] } },
])('refuses drift before inference %j', async (override) => {
  const f = fixture(override);
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification,
    httpClient: f.http,
  });
  expect((await collectReply(p.stream(request))).error).toMatchObject({ dispatch: 'not_sent' });
  expect(f.requests).toHaveLength(3);
});
it('performs preflight on every call and sends a bounded native profile', async () => {
  const f = fixture();
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification,
    httpClient: f.http,
  });
  const reply = await collectReply(p.stream(request));
  expect(reply.text).toBe('hello');
  expect(reply.stopReason).toBe('stop');
  expect(reply.usageEvidence).toEqual({ kind: 'unavailable', reason: 'not_reported' });
  await collectReply(p.stream(request));
  expect(f.requests).toHaveLength(8);
  expect(JSON.parse(f.requests[3]!.body!)).toMatchObject({
    model: 'qwen3:1.7b',
    stream: true,
    think: false,
    options: { num_ctx: 4096, num_predict: 512 },
  });
});
it.each([0, 513, 1.5, NaN])(
  'refuses invalid output request %s without metadata or inference',
  async (maxTokens) => {
    const f = fixture();
    const p = createLocalProvider({
      endpoint,
      auth: { mode: 'none' },
      qualification,
      httpClient: f.http,
    });
    expect((await collectReply(p.stream({ ...request, maxTokens }))).error).toMatchObject({
      code: 'invalid_request',
      dispatch: 'not_sent',
    });
    expect(f.requests).toHaveLength(0);
  },
);
it('qualifies completion-only metadata and dispatches text without any tool schema', async () => {
  const f = fixture({ '/api/show': { ...show, capabilities: ['completion'] } });
  const q = await checkLocalModel(
    { endpoint, auth: { mode: 'none' }, httpClient: f.http },
    new AbortController().signal,
  );
  expect(q.capabilities.tools).toBe(false);
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification: q,
    httpClient: f.http,
  });
  expect(p.capabilities.toolCalls).toBe(false);
  expect((await collectReply(p.stream(request))).text).toBe('hello');
  expect(JSON.parse(f.requests.at(-1)!.body!)).not.toHaveProperty('tools');
});
it.each(['schema', 'history'] as const)(
  'refuses text-only native %s before metadata or inference',
  async (kind) => {
    const f = fixture({ '/api/show': { ...show, capabilities: ['completion'] } });
    const q = { ...qualification, capabilities: { ...qualification.capabilities, tools: false } };
    const p = createLocalProvider({
      endpoint,
      auth: { mode: 'none' },
      qualification: q,
      httpClient: f.http,
    });
    const input =
      kind === 'schema'
        ? { ...request, tools: [] }
        : {
            ...request,
            messages: [
              {
                role: 'assistant' as const,
                content: '',
                toolCalls: [{ id: 'x', name: 'tool', arguments: '{}' }],
              },
              { role: 'tool' as const, content: 'x', toolCallId: 'x' },
            ],
          };
    expect((await collectReply(p.stream(input))).error).toMatchObject({ dispatch: 'not_sent' });
    expect(f.requests).toHaveLength(0);
  },
);
it('holds unrequested text-only tool candidates as an unknown stream without emitting calls', async () => {
  const f = fixture({ '/api/show': { ...show, capabilities: ['completion'] } }, [
    JSON.stringify({
      model: 'qwen3:1.7b',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'rogue', arguments: {} } }],
      },
      done: true,
      done_reason: 'stop',
    }) + '\n',
  ]);
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification: {
      ...qualification,
      capabilities: { ...qualification.capabilities, tools: false },
    },
    httpClient: f.http,
  });
  const events = [];
  for await (const event of p.stream(request)) events.push(event);
  expect(events.filter((event) => event.type === 'tool_call')).toEqual([]);
  expect(events.find((event) => event.type === 'error')).toMatchObject({
    error: { dispatch: 'unknown' },
  });
});
it.each([true, false])(
  'refuses tools=%s qualification drifting to the opposite profile before chat',
  async (tools) => {
    const f = fixture({
      '/api/show': { ...show, capabilities: tools ? ['completion'] : ['completion', 'tools'] },
    });
    const p = createLocalProvider({
      endpoint,
      auth: { mode: 'none' },
      qualification: { ...qualification, capabilities: { ...qualification.capabilities, tools } },
      httpClient: f.http,
    });
    expect((await collectReply(p.stream(request))).error).toMatchObject({ dispatch: 'not_sent' });
    expect(f.requests.some((r) => r.url.endsWith('/api/chat'))).toBe(false);
  },
);
it('rechecks dispatch authority after awaited metadata preflight and sends no inference on veto', async () => {
  const f = fixture();
  let allowed = true;
  const p = createLocalProvider({
    endpoint,
    auth: { mode: 'none' },
    qualification,
    httpClient: {
      async send(r) {
        const response = await f.http.send(r);
        if (r.url.endsWith('/api/show')) allowed = false;
        return response;
      },
    },
  });
  expect(
    (await collectReply(p.stream({ ...request, authorizeDispatch: () => allowed }))).error,
  ).toMatchObject({ dispatch: 'not_sent' });
  expect(f.requests.some((r) => r.url.endsWith('/api/chat'))).toBe(false);
});
