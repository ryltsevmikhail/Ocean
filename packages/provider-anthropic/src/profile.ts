import type { ProviderModelInfo } from '@runnets/provider-core';
export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2026-10-21';
export const ANTHROPIC_MODELS = ['claude-haiku-5-5'] as const;
export const ANTHROPIC_MODEL_INFO: readonly (ProviderModelInfo & {
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
})[] = [
  {
    id: 'claude-haiku-5-5',
    inputModalities: ['text', 'image'],
    contextTokens: 1000000,
    maxOutputTokens: 128000,
  },
];
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
}
