import type { ProviderModelInfo } from '@runnets/provider-core';
export const OPENAI_ORIGIN = 'https://api.openai.com';
export const OPENAI_MODELS = ['gpt-5.6-terra'] as const;
export const OPENAI_MODEL_INFO: readonly (ProviderModelInfo & {
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
})[] = [
  {
    id: 'gpt-5.6-terra',
    inputModalities: ['text', 'image'],
    contextTokens: 1050000,
    maxOutputTokens: 128000,
  },
];
