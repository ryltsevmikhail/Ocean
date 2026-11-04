import { expect, it } from 'vitest';
import { createFetchHttpClient } from '@runnets/provider-core';
import { createProviderActivationFactory } from './provider-activation-factory.js';
const descriptor = {
  connectionId: 'openai-account',
  providerId: 'openai',
  kind: 'cloud' as const,
  endpoint: 'https://api.openai.com',
  auth: 'api_key' as const,
  defaultModelId: 'gpt-5.6-terra',
};
it('owns static pinned capacity and binds only the saved credential to canonical inference and probe', async () => {
  const calls: { url: string; auth: string | undefined }[] = [];
  const factory = createProviderActivationFactory({
    env: new Proxy(
      {},
      {
        get() {
          throw Error('environment read');
        },
      },
    ),
    httpClient: {
      async send(r) {
        calls.push({ url: r.url, auth: r.headers.authorization });
        return {
          status: 200,
          ok: true,
          text: async () => '',
          async *stream() {
            if (r.method === 'GET') yield '{"data":[{"id":"gpt-5.6-terra"}]}';
            else
              yield 'data: {"model":"gpt-5.6-terra","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
          },
        };
      },
    },
  });
  expect(factory.catalog(descriptor)).toEqual([
    {
      modelId: 'gpt-5.6-terra',
      capabilities: {
        tools: true,
        streaming: true,
        inputModalities: ['text', 'image'],
        contextTokens: 1050000,
        maxOutputTokens: 128000,
        usage: 'reported',
      },
    },
  ]);
  expect(factory.external(descriptor)).toBeNull();
  expect(factory.activate(descriptor, { status: 'absent' })).toBeNull();
  const credential = factory.activate(descriptor, { status: 'ok', key: 'saved-key' })!;
  expect(credential.source).toBe('saved');
  for await (const _event of credential.provider.stream({ model: 'gpt-5.6-terra', messages: [] })) {
    /* drain */
  }
  expect(await credential.check(new AbortController().signal)).toMatchObject({
    outcome: 'ok',
    models: ['gpt-5.6-terra'],
  });
  expect(calls).toEqual([
    { url: 'https://api.openai.com/v1/chat/completions', auth: 'Bearer saved-key' },
    { url: 'https://api.openai.com/v1/models', auth: 'Bearer saved-key' },
  ]);
});
it.each([
  'https://proxy.invalid',
  'https://api.openai.com/v1',
  'https://api.openai.com/',
  'https://api.openai.com?',
  'https://API.openai.com',
  'http://api.openai.com',
  null,
])('refuses unsupported OpenAI descriptor endpoint %s before any credential access', (endpoint) => {
  const factory = createProviderActivationFactory({
    env: new Proxy(
      {},
      {
        get() {
          throw Error('environment read');
        },
      },
    ),
  });
  const d = { ...descriptor, endpoint };
  expect(factory.catalog(d)).toEqual([]);
  expect(
    factory.activate(d, {
      status: 'ok',
      get key(): string {
        throw Error('saved key read');
      },
    }),
  ).toBeNull();
  expect(factory.external(d)).toBeNull();
});

it.each([
  [307, 'https://api.openai.com/v1/other'],
  [308, 'https://redirect.invalid/chat'],
])(
  'uses no-follow fetch policy for canonical inference and probe on HTTP %s',
  async (status, location) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const httpClient = createFetchHttpClient(async (url, init) => {
      calls.push({ url, init });
      return new Response(null, {
        status: status as number,
        headers: { location: location as string },
      });
    });
    const factory = createProviderActivationFactory({ env: {}, httpClient });
    const credential = factory.activate(descriptor, { status: 'ok', key: 'fixture-key' })!;
    const events = [];
    for await (const event of credential.provider.stream({
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'private transcript' }],
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { status, dispatch: 'unknown' } });
    expect(await credential.check(new AbortController().signal)).toEqual({
      outcome: 'unavailable',
      httpStatus: status,
      models: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/models',
    ]);
    expect(calls.map((c) => c.init.redirect)).toEqual(['manual', 'manual']);
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET']);
    expect(calls[0]!.init.body).toContain('private transcript');
    expect(calls[1]!.init.body).toBeUndefined();
  },
);
