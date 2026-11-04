import type { ModelPendingRequest } from './model-pending-request.js';
import type { LocalModelQualification } from './model-local-qualification.js';
import type { ProviderConnectionReceipt } from './provider-connection-ports.js';
import type { ModelCheckMetadata, ModelConnectionStatus } from './model-connection-types.js';

export type ModelConnectionIntent = 'unconfigured' | 'active' | 'disconnected' | 'pending';
export interface ModelSecretChange {
  readonly action: 'replace' | 'remove';
  readonly previousRef: string | null;
  readonly nextRef: string | null;
}
/** Internal metadata only; neither credential bytes nor a client-facing DTO. */
export interface ModelConnectionRecord {
  readonly connectionId: string;
  readonly providerId: string;
  readonly kind: 'cloud' | 'local';
  readonly endpoint: string | null;
  readonly auth: 'api_key' | 'none';
  readonly defaultModelId: string | null;
  readonly localQualification: LocalModelQualification | null;
  readonly secretRef: string | null;
  readonly intent: ModelConnectionIntent;
  /** Zero is reserved for a persisted inert placeholder. */
  readonly revision: number;
  readonly requestId: string | null;
  readonly binding: string | null;
  readonly lastCheck: ModelCheckMetadata | null;
  readonly updatedAt: string;
  readonly pendingSecretChange: ModelSecretChange | null;
  /** Missing only in historic snapshots; canonical decoders materialize null. */
  readonly pendingRequest?: ModelPendingRequest | null;
  /** Eligibility for the designated old fallback; intent and saved-reference precedence still apply. */
  readonly legacyEnvironment: boolean;
  readonly configuredAfterRestore: boolean;
}
/** Frozen internal result snapshot; never reinterpret legacy provider receipt JSON. */
export interface ModelConnectionReceipt {
  readonly binding: string;
  readonly result: ModelConnectionRecord;
  readonly publicResult?: { readonly version: 1; readonly status: ModelConnectionStatus };
}
export interface ModelConnectionStorePort {
  list(): readonly ModelConnectionRecord[];
  read(connectionId: string): ModelConnectionRecord | null;
  put(record: ModelConnectionRecord, expectedRevision: number | null): void;
  activate(
    record: ModelConnectionRecord,
    expectedRevision: number | null,
    receipt: { readonly requestId: string; readonly value: ModelConnectionReceipt },
  ): void;
  receipt(requestId: string): ModelConnectionReceipt | null;
}

/** Migration/legacy creation metadata, with no key lookup or activation claim. */
export function unconfiguredModelConnection(providerId: string): ModelConnectionRecord {
  return {
    connectionId: `legacy:${providerId}`,
    providerId,
    kind: 'cloud',
    endpoint: providerId === 'deepseek' ? 'https://api.deepseek.com' : null,
    auth: 'api_key',
    defaultModelId: null,
    localQualification: null,
    secretRef: null,
    intent: 'unconfigured',
    revision: 0,
    requestId: null,
    binding: null,
    lastCheck: null,
    updatedAt: '1970-01-01T00:00:00.000Z',
    pendingSecretChange: null,
    pendingRequest: null,
    legacyEnvironment: providerId === 'deepseek',
    configuredAfterRestore: false,
  };
}

/** Explicit durable bridge for the frozen legacy receipt namespace. */
export interface LegacyModelConnectionStorePort extends ModelConnectionStorePort {
  legacyReceipt(requestId: string): ProviderConnectionReceipt | null;
  activateLegacy(
    record: ModelConnectionRecord,
    expected: number | null,
    receipt: { readonly requestId: string; readonly value: ProviderConnectionReceipt },
  ): void;
}
