import { expect, it } from 'vitest';
import { createFetchHttpClient } from '@runnets/provider-core';
import { createProviderActivationFactory } from './provider-activation-factory.js';
const descriptor = {
  connectionId: 'anthropic-account',
  providerId: 'anthropic',
  kind: 'cloud' as const,
  endpoint: 'https://api.anthropic.com',
  auth: 'api_key' as const,
  defaultModelId: 'claude-haiku-5-5',
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
        calls.push({ url: r.url, auth: r.headers['x-api-key'] });
        return {
          status: 200,
          ok: true,
          text: async () => '',
          async *stream() {
            if (r.method === 'GET') yield '{"id":"claude-haiku-5-5"}';
            else
              yield 'event: message_start\ndata: {"type":"message_start","message":{"type":"message","role":"assistant","model":"claude-haiku-5-5","content":[]}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
          },
        };
      },
    },
  });
  expect(factory.catalog(descriptor)).toEqual([
    {
      modelId: 'claude-haiku-5-5',
      capabilities: {
        tools: true,
        streaming: true,
        inputModalities: ['text', 'image'],
        contextTokens: 1000000,
        maxOutputTokens: 128000,
        usage: 'reported',
      },
    },
  ]);
  expect(factory.external(descriptor)).toBeNull();
  expect(factory.activate(descriptor, { status: 'absent' })).toBeNull();
  const credential = factory.activate(descriptor, { status: 'ok', key: 'saved-key' })!;
  expect(credential.source).toBe('saved');
  for await (const _event of credential.provider.stream({
    model: 'claude-haiku-5-5',
    messages: [],
  })) {
    /* drain */
  }
  expect(await credential.check(new AbortController().signal)).toMatchObject({
    outcome: 'ok',
    models: ['claude-haiku-5-5'],
  });
  expect(calls).toEqual([
    { url: 'https://api.anthropic.com/v1/messages', auth: 'saved-key' },
    { url: 'https://api.anthropic.com/v1/models/claude-haiku-5-5', auth: 'saved-key' },
  ]);
});
it.each([
  'https://proxy.invalid',
  'https://api.anthropic.com/v1',
  'https://api.anthropic.com/',
  'https://api.anthropic.com?',
  'https://API.anthropic.com',
  'http://api.anthropic.com',
  null,
])(
  'refuses unsupported Anthropic descriptor endpoint %s before any credential access',
  (endpoint) => {
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
  },
);

it.each([
  [307, 'https://api.anthropic.com/v1/other'],
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
      model: 'claude-haiku-5-5',
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
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/models/claude-haiku-5-5',
    ]);
    expect(calls.map((c) => c.init.redirect)).toEqual(['manual', 'manual']);
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'GET']);
    expect(calls[0]!.init.body).toContain('private transcript');
    expect(calls[1]!.init.body).toBeUndefined();
  },
);
