import { expect, it } from 'vitest';
import { createProviderActivationFactory } from './provider-activation-factory.js';
import { DEEPSEEK_MODEL_INFO } from '@runnets/provider-deepseek';

it('owns accurate static DeepSeek metadata without resolving credentials or changing descriptors', () => {
  const factory = createProviderActivationFactory({
    env: new Proxy(
      {},
      {
        get: () => {
          throw Error('secret read');
        },
      },
    ),
  });
  const descriptor = Object.freeze({
    connectionId: 'account',
    providerId: 'deepseek',
    kind: 'cloud' as const,
    endpoint: 'https://configured.invalid',
    auth: 'api_key' as const,
    defaultModelId: 'retired',
  });
  const models = factory.catalog(descriptor);
  expect(models.map((m) => m.modelId)).toEqual(DEEPSEEK_MODEL_INFO.map((m) => m.id));
  for (const model of models)
    expect(model.capabilities).toMatchObject({
      tools: true,
      streaming: true,
      contextTokens: null,
      maxOutputTokens: null,
      usage: 'reported',
      inputModalities: DEEPSEEK_MODEL_INFO.find((m) => m.id === model.modelId)?.inputModalities,
    });
  expect(factory.catalog({ ...descriptor, providerId: 'unsupported' })).toEqual([]);
  expect(factory.catalog({ ...descriptor, endpoint: null })).toEqual([]);
  expect(descriptor.defaultModelId).toBe('retired');
});
it('uses the unchanged configured endpoint for chat and probe through the injected transport', async () => {
  const requests: string[] = [];
  const factory = createProviderActivationFactory({
    env: {},
    httpClient: {
      send: async (request) => {
        requests.push(request.url);
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ data: [{ id: 'deepseek-flash' }] }),
          async *stream() {
            yield 'data: [DONE]\n\n';
          },
        };
      },
    },
  });
  const descriptor = {
    connectionId: 'custom',
    providerId: 'deepseek',
    kind: 'cloud' as const,
    endpoint: 'https://configured.invalid/v1',
    auth: 'api_key' as const,
    defaultModelId: 'deepseek-flash',
  };
  const credential = factory.activate(descriptor, { status: 'ok', key: 'fixture-key' });
  expect(credential).not.toBeNull();
  for await (const _event of credential!.provider.stream({
    model: 'deepseek-flash',
    messages: [],
  })) {
    /* drain fixture stream */
  }
  await credential!.check(new AbortController().signal);
  expect(requests).toEqual([
    'https://configured.invalid/v1/chat/completions',
    'https://configured.invalid/v1/models',
  ]);
});
