import { expect, it } from 'vitest';
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
