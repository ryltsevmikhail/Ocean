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
    localQualification: null,
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
    localQualification: null,
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

const invalidPersistedEndpoints = [
  'http://example.invalid',
  'https://user@example.invalid/v1',
  'https://user:password@example.invalid/v1',
  'https://example.invalid/v1?key=value',
  'https://example.invalid/v1#fragment',
  'https://example.invalid?',
  'https://example.invalid#',
  'https://example.invalid/',
  'https://EXAMPLE.invalid',
  'https://example.invalid:443',
  'https://example.invalid/v1/../api',
  ' https://example.invalid',
];
it.each(invalidPersistedEndpoints)(
  'refuses persisted endpoint %s in catalog and both credential entry points',
  (endpoint) => {
    let environmentReads = 0,
      savedKeyReads = 0;
    const factory = createProviderActivationFactory({
      env: new Proxy(
        {},
        {
          get: () => {
            environmentReads++;
            return 'fixture-environment-key';
          },
        },
      ),
    });
    const descriptor = {
      connectionId: 'persisted',
      providerId: 'deepseek',
      kind: 'cloud' as const,
      endpoint,
      auth: 'api_key' as const,
      defaultModelId: 'deepseek-flash',
      localQualification: null,
    };
    const models = factory.catalog(descriptor);
    const saved = factory.activate(descriptor, {
      status: 'ok',
      get key() {
        savedKeyReads++;
        return 'fixture-saved-key';
      },
    });
    const external = factory.external(descriptor);
    expect(models).toEqual([]);
    expect(saved).toBeNull();
    expect(external).toBeNull();
    expect(environmentReads).toBe(0);
    expect(savedKeyReads).toBe(0);
  },
);
