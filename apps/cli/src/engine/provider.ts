/**
 * Provider wiring for CLI hosts.
 *
 * Key resolution belongs to the host: the adapter receives the value and never
 * reads the environment, so the key cannot leak into an event, a log line or an
 * error message.
 */

import type { ProviderPort } from '@runnets/provider-core';
import { DeepSeekProvider } from '@runnets/provider-deepseek';

export const PROVIDER_ENV_KEY = 'DEEPSEEK_API_KEY';

/** Resolve the configured provider, or null when no key is present. */
export function createProviderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ProviderPort | null {
  const apiKey = env[PROVIDER_ENV_KEY];
  if (apiKey === undefined || apiKey.trim() === '') return null;
  return new DeepSeekProvider({ apiKey });
}
