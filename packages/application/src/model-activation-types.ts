import type { BoundBot, ConversationResult, ModelActivationSnapshot } from '@runnets/domain';
import type { ProviderPort } from './provider.js';

export interface ProviderActivation {
  readonly snapshot: ModelActivationSnapshot;
  readonly provider: ProviderPort;
}
export interface ProviderActivationPort {
  resolve(bot: BoundBot, admittedAt: string): ConversationResult<ProviderActivation>;
}
