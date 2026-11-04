import type { ModelConnectionRecord } from './model-connection-ports.js';
import type { ModelCatalogEntry } from './model-connection-types.js';
import type { ModelConnectionSource } from './model-connection-types.js';
import type { ModelCredential, ModelCredentialFactory } from './model-credential-ports.js';
import type {
  ProviderConnectionState,
  ProviderSecretStorePort,
} from './provider-connection-ports.js';
import type { ProviderPort } from './provider.js';
export interface ModelConnectionResolution {
  readonly selectedModel?: ModelCatalogEntry;
  readonly source: ModelConnectionSource;
  readonly state: ProviderConnectionState;
  readonly code: string | null;
  readonly credential: ModelCredential | null;
}
export interface ModelConnectionGates {
  readonly restored?: boolean;
  readonly injected?: ProviderPort | null;
  readonly disabled?: boolean;
  readonly mutationsAllowed?: boolean;
}
export function resolveModelConnection(
  record: ModelConnectionRecord,
  factory: ModelCredentialFactory,
  secrets: ProviderSecretStorePort,
  gates: ModelConnectionGates,
  selectedModelId?: string,
): ModelConnectionResolution {
  const no = (state: ProviderConnectionState, code: string | null): ModelConnectionResolution => ({
    source: 'none',
    state,
    code,
    credential: null,
  });
  if (gates.disabled === true) return no('absent', null);
  if (gates.injected !== null && gates.injected !== undefined)
    return { source: 'injected', state: 'connected', code: null, credential: null };
  if (gates.restored === true && !record.configuredAfterRestore)
    return no('restored', 'provider_restored');
  if (record.intent === 'pending') return no('unverified', 'provider_unverified');
  if (record.intent === 'disconnected') return no('disconnected', 'provider_disconnected');
  const selectedModel =
    selectedModelId === undefined
      ? undefined
      : factory.catalog(record).find((m) => m.modelId === selectedModelId);
  if (selectedModelId !== undefined && (!selectedModel || !selectedModel.capabilities.streaming))
    return no('invalid_model', 'provider_invalid_model');
  let credential: ModelCredential | null = null;
  try {
    if (record.secretRef !== null) {
      const secret = secrets.read(record.secretRef);
      if (secret.status !== 'ok')
        return no(
          'unverified',
          secret.status === 'unverified' ? secret.reason : 'provider_unverified',
        );
      credential = factory.activate(record, secret);
      if (credential?.source !== 'saved') return no('unverified', 'provider_unverified');
    } else if (record.auth === 'none' && record.kind === 'local') {
      credential = factory.activate(record, null);
      if (credential?.source !== 'auth_none') return no('unverified', 'provider_unverified');
    } else if (record.legacyEnvironment) {
      credential = factory.external(record);
      if (credential !== null && credential.source !== 'external')
        return no('unverified', 'provider_unverified');
    }
  } catch {
    return no('unverified', 'provider_unverified');
  }
  if (credential === null) return no('absent', null);
  const model =
    selectedModelId ?? record.defaultModelId ?? factory.catalog(record)[0]?.modelId ?? null;
  if (
    model === null ||
    (selectedModelId === undefined && !factory.catalog(record).some((m) => m.modelId === model))
  )
    return { ...no('invalid_model', 'provider_invalid_model'), source: credential.source };
  return {
    source: credential.source,
    state: 'connected',
    code: null,
    credential,
    ...(selectedModel === undefined ? {} : { selectedModel }),
  };
}
