/**
 * @runnets/provider-deepseek — DeepSeek streaming adapter.
 *
 * Implements the provider-neutral `ProviderPort` over the OpenAI-compatible
 * DeepSeek chat completions API. Only this package knows vendor wire shapes.
 */

export {
  DEEPSEEK_MODELS,
  DeepSeekProvider,
  createDeepSeekProvider,
  type DeepSeekProviderOptions,
} from './provider.js';
