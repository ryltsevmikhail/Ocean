import type { ConversationStore } from './conversation-ports.js';
import type { ModelConnectionStorePort, ModelConnectionRecord } from './model-connection-ports.js';
import type { ModelCredentialFactory } from './model-credential-ports.js';
import type { ModelConnectionGates } from './model-connection-resolution.js';
import type { ModelPendingRequest } from './model-pending-request.js';
import type { ModelCatalogEntry, ModelCheckMetadata } from './model-connection-types.js';
import type { LocalModelQualification } from './model-local-qualification.js';
import { modelConnectionRecord } from './model-connection-validation.js';
import { boundedModelText } from './model-connection-input.js';
import { copyModelCatalogEntry } from './model-connection-results.js';
import { boundedModelPage, modelReadPage, type ModelReadPageInput } from './model-read-pages.js';
export type ModelConnectionRecovery =
  | {
      readonly kind: 'retry_available';
      readonly pendingRevision: number;
      readonly request: ModelPendingRequest;
      readonly requiresKeyResupply: boolean;
    }
  | {
      readonly kind: 'original_input_required';
      readonly pendingRevision: number;
      readonly requestId: string | null;
    }
  | { readonly kind: 'explicit_key_repair_required'; readonly pendingRevision: number }
  | null;
export interface ModelConnectionMetadata {
  readonly connectionId: string;
  readonly providerId: string;
  readonly kind: 'cloud' | 'local';
  readonly endpoint: string | null;
  readonly auth: 'api_key' | 'none';
  readonly defaultModelId: string | null;
  readonly revision: number;
  readonly configuration: {
    readonly intent: ModelConnectionRecord['intent'];
    readonly savedKeyReferencePresent: boolean;
    readonly configuredAfterRestore: boolean;
  };
  readonly models: readonly ModelCatalogEntry[];
  readonly lastCheck: ModelCheckMetadata | null;
  readonly localQualification: LocalModelQualification | null;
  readonly recovery: ModelConnectionRecovery;
  readonly writable: boolean;
  readonly restriction: 'restore_restricted' | 'provider_injected' | 'provider_unavailable' | null;
}
export interface ModelConnectionMetadataInput extends ModelReadPageInput {
  readonly workspaceId?: string;
}
export interface ModelConnectionMetadataPage {
  readonly version: 1;
  readonly workspaceId: string | null;
  readonly items: readonly ModelConnectionMetadata[];
  readonly nextAfter: string | null;
}
export interface ModelConnectionMetadataDeps extends ModelConnectionGates {
  readonly store: Pick<ModelConnectionStorePort, 'list'>;
  readonly factory: Pick<ModelCredentialFactory, 'catalog'>;
  /** Required when a caller supplies workspaceId; connection ownership remains profile-level. */
  readonly conversations?: ConversationStore;
}
function recovery(row: ModelConnectionRecord): ModelConnectionRecovery {
  if (row.intent !== 'pending') return null;
  if (row.pendingSecretChange === null)
    return { kind: 'explicit_key_repair_required', pendingRevision: row.revision };
  if (row.pendingRequest === null || row.pendingRequest === undefined)
    return {
      kind: 'original_input_required',
      pendingRevision: row.revision,
      requestId: row.requestId,
    };
  const operation = row.pendingRequest.operation;
  return {
    kind: 'retry_available',
    pendingRevision: row.revision,
    request: row.pendingRequest,
    requiresKeyResupply: 'keyWasSupplied' in operation && operation.keyWasSupplied,
  };
}
/** Canonical metadata only. Reference presence and previous checks never claim current health. */
export class ModelConnectionMetadataService {
  readonly deps: ModelConnectionMetadataDeps;
  constructor(deps: ModelConnectionMetadataDeps) {
    this.deps = deps;
  }
  list(input: ModelConnectionMetadataInput = {}): ModelConnectionMetadataPage {
    const settings = modelReadPage(input, 256);
    const workspaceId =
      input.workspaceId === undefined ? null : boundedModelText(input.workspaceId, 128);
    if (
      workspaceId !== null &&
      this.deps.conversations?.atomic((tx) => tx.workspace()?.id) !== workspaceId
    )
      throw Error('workspace_conflict');
    const scope = { version: 1 as const, workspaceId };
    const restriction =
      this.deps.mutationsAllowed === false
        ? 'restore_restricted'
        : this.deps.injected !== null && this.deps.injected !== undefined
          ? 'provider_injected'
          : this.deps.disabled === true
            ? 'provider_unavailable'
            : null;
    const page = boundedModelPage(
      this.deps.store.list(),
      settings,
      (r) => r.connectionId,
      (raw): ModelConnectionMetadata => {
        const row = modelConnectionRecord(raw);
        boundedModelText(row.connectionId, 256);
        const catalog = this.deps.factory.catalog(row);
        if (catalog.length > 200) throw Error('projection_too_large');
        return {
          connectionId: row.connectionId,
          providerId: row.providerId,
          kind: row.kind,
          endpoint: row.endpoint,
          auth: row.auth,
          defaultModelId: row.defaultModelId,
          revision: row.revision,
          configuration: {
            intent: row.intent,
            savedKeyReferencePresent: row.secretRef !== null,
            configuredAfterRestore: row.configuredAfterRestore,
          },
          models: catalog.map(copyModelCatalogEntry),
          lastCheck: row.lastCheck,
          localQualification: row.localQualification,
          recovery: recovery(row),
          writable: restriction === null,
          restriction,
        };
      },
      scope,
    );
    return { ...scope, ...page };
  }
}
