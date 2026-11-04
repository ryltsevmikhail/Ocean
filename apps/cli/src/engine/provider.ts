/**
 * Provider wiring for env-only hosts (CLI, TUI, ACP).
 *
 * Key resolution belongs to the host: the adapter receives the value and never
 * reads the environment, so the key cannot leak into an event, a log line or an
 * error message. This is an explicitly *external* credential source: the
 * runtime-owned settings API never copies it into the private Ocean store, and
 * an explicit owner disconnect in the shared runtime blocks it.
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
