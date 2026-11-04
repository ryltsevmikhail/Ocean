import type { ModelCapabilities } from '@runnets/domain';
import type { ProviderCheckOutcome, ProviderConnectionState } from './provider-connection-ports.js';
export type ModelConnectionSource = 'saved' | 'external' | 'auth_none' | 'injected' | 'none';
export interface ModelCatalogEntry {
  readonly modelId: string;
  readonly capabilities: ModelCapabilities;
}
export interface ModelCheckMetadata {
  readonly connectionId: string;
  readonly outcome: ProviderCheckOutcome;
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly models: readonly string[];
  readonly modelSupported: boolean;
  readonly source: ModelConnectionSource;
  readonly revision: number;
  readonly checkedAt: string;
}
export interface ModelCheckResult extends ModelCheckMetadata {
  readonly persisted: boolean;
}
export interface ModelConnectionStatus {
  readonly connectionId: string;
  readonly providerId: string;
  readonly kind: 'cloud' | 'local';
  readonly endpoint: string | null;
  readonly auth: 'api_key' | 'none';
  readonly defaultModelId: string | null;
  readonly source: ModelConnectionSource;
  readonly state: ProviderConnectionState;
  readonly models: readonly ModelCatalogEntry[];
  readonly revision: number;
  readonly savedKey: boolean;
  readonly writable: boolean;
  readonly code: string | null;
  readonly lastCheck: ModelCheckMetadata | null;
}
export interface ModelConnectionCheck {
  readonly status: ModelConnectionStatus;
  readonly check: ModelCheckResult;
}
export interface ModelConnectionRevisionInput {
  readonly connectionId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface ModelConnectionSetInput extends Omit<
  ModelConnectionRevisionInput,
  'expectedRevision'
> {
  readonly expectedRevision: number | null;
  readonly providerId: string;
  readonly kind: 'cloud' | 'local';
  readonly endpoint: string;
  readonly auth: 'api_key' | 'none';
  readonly defaultModelId: string;
  readonly key?: string;
}
