import type { ModelConnectionRecord } from './model-connection-ports.js';
import type { ModelCatalogEntry } from './model-connection-types.js';
import type { ProviderProbeResult, ProviderSecretRead } from './provider-connection-ports.js';
import type { ProviderPort } from './provider.js';
export type ModelConnectionDescriptor = Pick<
  ModelConnectionRecord,
  'connectionId' | 'providerId' | 'kind' | 'endpoint' | 'auth' | 'defaultModelId'
>;
export interface ModelCredential {
  readonly source: 'saved' | 'external' | 'auth_none';
  readonly provider: ProviderPort;
  check(signal: AbortSignal): Promise<ProviderProbeResult>;
}
export interface ModelCredentialFactory {
  catalog(connection: ModelConnectionDescriptor): readonly ModelCatalogEntry[];
  activate(
    connection: ModelConnectionDescriptor,
    secret: ProviderSecretRead | null,
  ): ModelCredential | null;
  external(connection: ModelConnectionDescriptor): ModelCredential | null;
}
