import { conversationFailure, ok, type BoundBot, type ConversationResult } from '@runnets/domain';
import type { ModelConnectionStorePort } from './model-connection-ports.js';
import type { ModelCredentialFactory } from './model-credential-ports.js';
import type { ProviderSecretStorePort } from './provider-connection-ports.js';
import type { ProviderActivation, ProviderActivationPort } from './model-activation-types.js';
import { validModelConnectionEndpoint } from './model-connection-input.js';
import { resolveModelConnection } from './model-connection-resolution.js';
import {
  freezeModelActivation,
  hostModelActivation,
  DEFAULT_MODEL_EXECUTION_LIMITS,
} from './model-activation-snapshot.js';
import type { ProviderPort } from './provider.js';

export interface ProviderActivationDeps {
  /** Reads must share the admitting conversation transaction's synchronous snapshot. */
  readonly connections: Pick<ModelConnectionStorePort, 'read'>;
  readonly factory: ModelCredentialFactory;
  readonly secrets: ProviderSecretStorePort;
  readonly restored: boolean;
  readonly disabled: boolean;
}
/** Local-only activation; the caller owns the receipt-first admitting transaction. */
export class ProviderActivationService implements ProviderActivationPort {
  readonly #deps: ProviderActivationDeps;
  constructor(deps: ProviderActivationDeps) {
    this.#deps = deps;
  }
  resolve({ bot, binding }: BoundBot, admittedAt: string): ConversationResult<ProviderActivation> {
    const no = () => conversationFailure('provider_unavailable');
    const d = this.#deps;
    const record = d.connections.read(binding.connectionId);
    if (
      record === null ||
      record.providerId !== bot.provider ||
      binding.modelId !== bot.model ||
      !validModelConnectionEndpoint(record.kind, record.endpoint)
    )
      return no();
    const resolution = resolveModelConnection(record, d.factory, d.secrets, d, binding.modelId);
    const provider = resolution.credential?.provider;
    if (
      resolution.state !== 'connected' ||
      !provider ||
      provider.id !== record.providerId ||
      !provider.models.includes(binding.modelId) ||
      !provider.capabilities.streaming
    )
      return no();
    const model = resolution.selectedModel;
    if (!model || !model.capabilities.streaming) return no();
    const limits = DEFAULT_MODEL_EXECUTION_LIMITS;
    const snapshot = freezeModelActivation({
      version: 1,
      identity: {
        source: 'connection',
        ...binding,
        providerId: record.providerId,
        connectionRevision: record.revision,
        botProfileVersion: bot.profileVersion,
        kind: record.kind,
        endpoint: record.endpoint,
        auth: record.auth,
        artifactDigest: record.localQualification?.artifactDigest ?? null,
        backendVersion: record.localQualification?.backendVersion ?? null,
      },
      capabilities: model.capabilities,
      limits,
      admittedAt,
      deadlineAt: new Date(Date.parse(admittedAt) + limits.turnTimeoutMs).toISOString(),
    });
    return ok({ provider, snapshot });
  }
}
/** Deliberate injected-host mode; never used as a production resolution fallback. */
export function injectedProviderActivation(provider: ProviderPort | null): ProviderActivationPort {
  return {
    resolve: ({ bot }, admittedAt) =>
      provider === null ||
      provider.id !== bot.provider ||
      !provider.models.includes(bot.model) ||
      !provider.capabilities.streaming
        ? conversationFailure('provider_unavailable')
        : ok({ provider, snapshot: hostModelActivation(provider, bot.model, admittedAt) }),
  };
}
