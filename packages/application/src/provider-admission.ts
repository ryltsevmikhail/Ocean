/**
 * One provider admission rule for both addressed turns and broadcast children.
 *
 * A model turn may only be admitted when the active immutable provider snapshot
 * serves the bot's provider and model and can stream with usage accounting.
 */

import type { Bot } from '@runnets/domain';
import type { ProviderPort } from './provider.js';

export type ProviderAdmissionBot = Pick<Bot, 'provider' | 'model'>;
/** Narrow the nullable activation to a provider that can actually serve this bot. */
export function providerAdmits(
  provider: ProviderPort | null,
  bot: ProviderAdmissionBot,
): provider is ProviderPort {
  return (
    provider !== null &&
    provider.id === bot.provider &&
    provider.models.includes(bot.model) &&
    provider.capabilities.streaming === true &&
    provider.capabilities.usage === true
  );
}
