/** Frozen legacy DTO projection over the canonical connection read model. */
import type { ModelConnectionRecord } from './model-connection-ports.js';
import type { ModelCheckMetadata } from './model-connection-types.js';
import type { ModelConnectionResolution } from './model-connection-resolution.js';
import {
  ModelConnectionReadModel,
  type ModelConnectionServiceOptions,
} from './model-connection-state.js';
import type {
  ProviderCheckMetadata,
  ProviderConnectionStatus,
  ProviderCredentialPort,
} from './provider-connection-ports.js';
export function legacyCheck(check: ModelCheckMetadata | null): ProviderCheckMetadata | null {
  if (check === null) return null;
  if (check.source === 'auth_none') throw Error('provider_unverified');
  const { connectionId: _id, ...result } = check;
  return { ...result, source: check.source };
}
export function legacyStatus(
  state: ModelConnectionReadModel,
  record: ModelConnectionRecord,
  credentials: ProviderCredentialPort,
  resolution = state.resolve(record),
): ProviderConnectionStatus {
  if (!record.legacyEnvironment || resolution.source === 'auth_none')
    throw Error('provider_unverified');
  const selected = record.defaultModelId ?? credentials.models[0] ?? null;
  const invalid =
    resolution.state === 'disconnected' &&
    selected !== null &&
    !credentials.models.includes(selected);
  return {
    provider: credentials.providerId,
    source: resolution.source,
    state: invalid ? 'invalid_model' : resolution.state,
    model: resolution.state === 'restored' || resolution.state === 'unverified' ? null : selected,
    models: credentials.models,
    modelCapabilities: credentials.modelCapabilities,
    revision: record.revision,
    savedKey: record.secretRef !== null,
    writable:
      state.options.mutationsAllowed !== false &&
      (state.options.injected === null || state.options.injected === undefined) &&
      state.options.disabled !== true,
    code: invalid ? 'provider_invalid_model' : resolution.code,
    lastCheck: legacyCheck(record.lastCheck),
  };
}
/** Kept as an explicit compatibility read wrapper; canonical state owns all resolution/checks. */
export class ProviderConnectionReadModel {
  readonly state: ModelConnectionReadModel;
  readonly credentials: ProviderCredentialPort;
  constructor(options: ModelConnectionServiceOptions, credentials: ProviderCredentialPort) {
    this.credentials = credentials;
    this.state = new ModelConnectionReadModel(options);
  }
  statusFor(record: ModelConnectionRecord, resolution?: ModelConnectionResolution) {
    return legacyStatus(this.state, record, this.credentials, resolution);
  }
}
