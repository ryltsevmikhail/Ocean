/**
 * One provider admission rule for both addressed turns and broadcast children.
 *
 * A model turn may only be admitted when the active immutable provider snapshot
 * serves the bot's provider/model and streams. Frozen capabilities replace the
 * legacy usage boolean; the engine enforces exact-token accounting eligibility.
 */

import type { Bot, ModelActivationSnapshot } from '@runnets/domain';
import type { ProviderPort } from './provider.js';

export type ProviderAdmissionBot = Pick<Bot, 'provider' | 'model'>;
/** Narrow the nullable activation to a provider that can actually serve this bot. */
export function providerAdmits(
  provider: ProviderPort | null,
  bot: ProviderAdmissionBot,
  activation?: ModelActivationSnapshot,
): provider is ProviderPort {
  return (
    provider !== null &&
    provider.id === bot.provider &&
    provider.models.includes(bot.model) &&
    provider.capabilities.streaming === true &&
    (activation === undefined
      ? provider.capabilities.usage === true
      : activation.identity.providerId === bot.provider &&
        activation.identity.modelId === bot.model &&
        activation.capabilities.streaming)
  );
}
