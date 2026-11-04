/** Negotiated owner IPC: key-bearing inputs, closed keyless results and recovery. */
import type { LocalProviderSetRequest, LocalProviderRevisionRequest } from './local-provider.js';
export const LOCAL_MODEL_CONNECTIONS = 'model.connections-v1';
export const LOCAL_MODEL_METHODS = [
  'modelConnections.list',
  'modelConnections.set',
  'modelConnections.check',
  'modelConnections.disconnect',
  'modelConnections.removeSavedKey',
  'bots.createBound',
  'bots.setModelBinding',
  'bots.listBound',
  'runs.modelExecution',
  'rooms.getModelPolicy',
  'rooms.setModelPolicy',
] as const;
export const LOCAL_MODEL_READ_METHODS = [
  'modelConnections.list',
  'bots.listBound',
  'runs.modelExecution',
  'rooms.getModelPolicy',
] as const;
export interface LocalModelPageQuery {
  readonly after?: string;
  readonly limit?: number;
}
export interface LocalModelConnectionsQuery extends LocalModelPageQuery {
  readonly workspaceId?: string;
}
export interface LocalModelConnectionQuery {
  readonly connectionId: string;
}
export interface LocalModelConnectionRevisionRequest extends LocalModelConnectionQuery {
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface LocalModelConnectionSetRequest extends Omit<
  LocalModelConnectionRevisionRequest,
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
export interface LocalModelCapabilities {
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly inputModalities: readonly ('text' | 'image')[];
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly usage: 'reported' | 'optional' | 'unavailable';
}
export interface LocalModelCatalogEntry {
  readonly modelId: string;
  readonly capabilities: LocalModelCapabilities;
}
export interface LocalModelQualification {
  readonly modelId: string;
  readonly artifactDigest: string;
  readonly backendVersion: string;
  readonly capabilities: LocalModelCapabilities;
  readonly configuredContextTokens: number;
}
export interface LocalModelCheckMetadata {
  readonly connectionId: string;
  readonly outcome: 'ok' | 'auth' | 'network' | 'timeout' | 'cancelled' | 'server' | 'unavailable';
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly models: readonly string[];
  readonly modelSupported: boolean;
  readonly source: 'saved' | 'external' | 'auth_none' | 'injected' | 'none';
  readonly revision: number;
  readonly checkedAt: string;
}
export interface LocalModelConnectionStatus {
  readonly connectionId: string;
  readonly providerId: string;
  readonly kind: 'cloud' | 'local';
  readonly endpoint: string | null;
  readonly auth: 'api_key' | 'none';
  readonly defaultModelId: string | null;
  readonly source: LocalModelCheckMetadata['source'];
  readonly state:
    'connected' | 'disconnected' | 'unverified' | 'absent' | 'restored' | 'invalid_model';
  readonly models: readonly LocalModelCatalogEntry[];
  readonly revision: number;
  readonly savedKey: boolean;
  readonly writable: boolean;
  readonly code: string | null;
  readonly lastCheck: LocalModelCheckMetadata | null;
}
export interface LocalModelConnectionCheckResponse {
  readonly status: LocalModelConnectionStatus;
  readonly check: LocalModelCheckMetadata & { readonly persisted: boolean };
}
export interface LocalModelPendingRequest {
  readonly version: 1;
  readonly operation:
    | {
        readonly method: 'modelConnections.set';
        readonly input: Omit<LocalModelConnectionSetRequest, 'key'>;
        readonly keyWasSupplied: boolean;
      }
    | {
        readonly method: 'modelConnections.removeSavedKey';
        readonly input: LocalModelConnectionRevisionRequest;
      }
    | {
        readonly method: 'provider.set';
        readonly input: Omit<LocalProviderSetRequest, 'key'>;
        readonly keyWasSupplied: boolean;
      }
    | { readonly method: 'provider.removeSavedKey'; readonly input: LocalProviderRevisionRequest };
}
export type LocalModelConnectionRecovery =
  | null
  | {
      readonly kind: 'retry_available';
      readonly pendingRevision: number;
      readonly request: LocalModelPendingRequest;
      readonly requiresKeyResupply: boolean;
    }
  | {
      readonly kind: 'original_input_required';
      readonly pendingRevision: number;
      readonly requestId: string | null;
    }
  | { readonly kind: 'explicit_key_repair_required'; readonly pendingRevision: number };
export interface LocalModelConnectionMetadata {
  readonly connectionId: string;
  readonly providerId: string;
  readonly kind: 'cloud' | 'local';
  readonly endpoint: string | null;
  readonly auth: 'api_key' | 'none';
  readonly defaultModelId: string | null;
  readonly revision: number;
  readonly configuration: {
    readonly intent: 'unconfigured' | 'active' | 'disconnected' | 'pending';
    readonly savedKeyReferencePresent: boolean;
    readonly configuredAfterRestore: boolean;
  };
  readonly models: readonly LocalModelCatalogEntry[];
  readonly lastCheck: LocalModelCheckMetadata | null;
  readonly localQualification: LocalModelQualification | null;
  readonly recovery: LocalModelConnectionRecovery;
  readonly writable: boolean;
  readonly restriction: 'restore_restricted' | 'provider_injected' | 'provider_unavailable' | null;
}
export interface LocalModelConnectionsPage {
  readonly version: 1;
  readonly workspaceId: string | null;
  readonly items: readonly LocalModelConnectionMetadata[];
  readonly nextAfter: string | null;
}
export interface LocalBotModelBinding {
  readonly connectionId: string;
  readonly modelId: string;
}
export interface LocalCreateBoundBotRequest {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly handle: string;
  readonly name: string;
  readonly role: string;
  readonly binding: LocalBotModelBinding;
}
export interface LocalSetBotModelBindingRequest {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly botId: string;
  readonly expectedProfileVersion: number;
  readonly binding: LocalBotModelBinding;
}
export interface LocalBoundBot {
  readonly bot: {
    readonly id: string;
    readonly workspaceId: string;
    readonly handle: string;
    readonly name: string;
    readonly role: string;
    readonly provider: string;
    readonly model: string;
    readonly profileVersion: number;
  };
  readonly binding: LocalBotModelBinding | null;
}
export interface LocalBoundBotsQuery extends LocalModelPageQuery {
  readonly workspaceId: string;
  readonly roomId?: string;
}
export interface LocalBoundBotsPage {
  readonly version: 1;
  readonly workspaceId: string;
  readonly roomId: string | null;
  readonly items: readonly LocalBoundBot[];
  readonly nextAfter: string | null;
}
export interface LocalRoomModelPolicyQuery {
  readonly workspaceId: string;
  readonly roomId: string;
}
export interface LocalRoomModelPolicy {
  readonly roomId: string;
  readonly revision: number;
  readonly cloudTransfer: 'allow' | 'deny';
}
export interface LocalRoomModelPolicySnapshot extends LocalRoomModelPolicyQuery {
  readonly version: 1;
  readonly policy: LocalRoomModelPolicy;
}
export interface LocalSetRoomModelPolicyRequest extends LocalRoomModelPolicyQuery {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly cloudTransfer: 'allow' | 'deny';
}
