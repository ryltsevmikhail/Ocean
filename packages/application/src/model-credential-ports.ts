import type { ModelConnectionRecord } from './model-connection-ports.js';
import type { ModelCatalogEntry } from './model-connection-types.js';
import type { ProviderProbeResult, ProviderSecretRead } from './provider-connection-ports.js';
import type { LocalModelQualification } from './model-local-qualification.js';
import type { ProviderCheckOutcome } from './provider-connection-ports.js';
import type { ProviderPort } from './provider.js';
export type ModelConnectionDescriptor = Pick<
  ModelConnectionRecord,
  | 'connectionId'
  | 'providerId'
  | 'kind'
  | 'endpoint'
  | 'auth'
  | 'defaultModelId'
  | 'localQualification'
>;
export interface ModelCredential {
  readonly source: 'saved' | 'external' | 'auth_none';
  readonly provider: ProviderPort;
  check(signal: AbortSignal): Promise<ProviderProbeResult>;
}
export type LocalModelCheckResult =
  | {
      readonly outcome: 'ok';
      readonly httpStatus: number;
      readonly qualification: LocalModelQualification;
    }
  | { readonly outcome: Exclude<ProviderCheckOutcome, 'ok'>; readonly httpStatus: number | null };
export interface LocalModelMetadataCheck {
  readonly source: 'saved' | 'auth_none';
  check(signal: AbortSignal): Promise<LocalModelCheckResult>;
}
export interface LocalModelBootstrapPort {
  acceptsDesired(connection: ModelConnectionDescriptor): boolean;
  prepareCheck(
    connection: ModelConnectionDescriptor,
    secret: ProviderSecretRead | null,
  ): LocalModelMetadataCheck | null;
}
export interface ModelCredentialFactory {
  readonly localBootstrap?: LocalModelBootstrapPort;
  catalog(connection: ModelConnectionDescriptor): readonly ModelCatalogEntry[];
  activate(
    connection: ModelConnectionDescriptor,
    secret: ProviderSecretRead | null,
  ): ModelCredential | null;
  external(connection: ModelConnectionDescriptor): ModelCredential | null;
}
