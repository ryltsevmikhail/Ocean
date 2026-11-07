import { createLocalActivationFactory } from './provider-local-factory.js';
import {
  validModelConnectionEndpoint,
  type ModelConnectionDescriptor,
  type ModelCredentialFactory,
  type ModelCredential,
} from '@runnets/application';
import {
  DeepSeekProvider,
  DEEPSEEK_MODEL_INFO,
  probeDeepSeekModels,
} from '@runnets/provider-deepseek';
import {
  createOpenAIProvider,
  probeOpenAIModels,
  OPENAI_ORIGIN,
  OPENAI_MODEL_INFO,
} from '@runnets/provider-openai';
import {
  createAnthropicProvider,
  probeAnthropicModels,
  ANTHROPIC_ORIGIN,
  ANTHROPIC_MODEL_INFO,
} from '@runnets/provider-anthropic';
import { PROVIDER_ENV_KEY } from '../engine/provider.js';
import type { ProviderCredentialOptions } from './provider-settings.js';

/** Adapter-owned catalog and descriptor-bound credentials, without network during admission. */
export function createProviderActivationFactory(
  options: ProviderCredentialOptions,
): ModelCredentialFactory {
  const local = createLocalActivationFactory(options.httpClient);
  const supported = (d: ModelConnectionDescriptor) =>
    (d.providerId === 'deepseek' ||
      (d.providerId === 'openai' && d.endpoint === OPENAI_ORIGIN) ||
      (d.providerId === 'anthropic' && d.endpoint === ANTHROPIC_ORIGIN)) &&
    d.kind === 'cloud' &&
    d.auth === 'api_key' &&
    validModelConnectionEndpoint(d.kind, d.endpoint);
  const activate = (
    d: ModelConnectionDescriptor,
    key: string,
    source: 'saved' | 'external',
  ): ModelCredential => ({
    source,
    provider:
      d.providerId === 'anthropic'
        ? createAnthropicProvider({
            apiKey: key,
            ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
          })
        : d.providerId === 'openai'
          ? createOpenAIProvider({
              apiKey: key,
              ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
            })
          : new DeepSeekProvider({
              apiKey: key,
              baseUrl: d.endpoint!,
              ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
            }),
    check: async (signal) => {
      if (d.providerId === 'anthropic')
        return probeAnthropicModels(
          {
            apiKey: key,
            ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
          },
          signal,
        );
      if (d.providerId === 'openai')
        return probeOpenAIModels(
          {
            apiKey: key,
            ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
          },
          signal,
        );
      const result = await probeDeepSeekModels({
        apiKey: key,
        baseUrl: d.endpoint!,
        signal,
        ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
      });
      const models = result.models.map((model) => model.id);
      return result.outcome === 'ok'
        ? { outcome: 'ok', httpStatus: result.httpStatus, models }
        : { outcome: result.outcome, httpStatus: result.httpStatus, models };
    },
  });
  return {
    localBootstrap: local.localBootstrap!,
    catalog: (d) =>
      d.kind === 'local'
        ? local.catalog(d)
        : !supported(d)
          ? []
          : d.providerId === 'openai' || d.providerId === 'anthropic'
            ? (d.providerId === 'openai' ? OPENAI_MODEL_INFO : ANTHROPIC_MODEL_INFO).map(
                (model) => ({
                  modelId: model.id,
                  capabilities: {
                    tools: true,
                    streaming: true,
                    inputModalities: [...model.inputModalities],
                    contextTokens: model.contextTokens,
                    maxOutputTokens: model.maxOutputTokens,
                    usage: 'reported' as const,
                  },
                }),
              )
            : DEEPSEEK_MODEL_INFO.map((model) => ({
                modelId: model.id,
                capabilities: {
                  tools: true,
                  streaming: true,
                  inputModalities: [...model.inputModalities],
                  contextTokens: null,
                  maxOutputTokens: null,
                  usage: 'reported',
                },
              })),
    activate: (d, secret) =>
      d.kind === 'local'
        ? local.activate(d, secret)
        : supported(d) && secret?.status === 'ok'
          ? activate(d, secret.key, 'saved')
          : null,
    external: (d) => {
      if (!supported(d) || d.providerId !== 'deepseek') return null;
      const key = options.env[PROVIDER_ENV_KEY];
      return !key?.trim() ? null : activate(d, key, 'external');
    },
  };
}
