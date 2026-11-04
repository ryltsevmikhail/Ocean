/**
 * Local-runtime plugin contract.
 *
 * Wire DTOs carry declarative catalog metadata, named connection references and
 * exact grant scopes. A credential VALUE never crosses this wire: connections
 * expose only the environment variable NAME the owner configured.
 */

export const LOCAL_PLUGIN_METHODS = [
  'plugin.catalog',
  'plugin.inspect',
  'plugin.install',
  'plugin.repair',
  'plugin.enable',
  'plugin.disable',
  'plugin.connections',
  'plugin.connection-add',
  'plugin.connection-preview',
  'plugin.connection-consent',
  'plugin.connection-discover',
  'plugin.connection-disconnect',
  'plugin.access-list',
  'plugin.access-preview',
  'plugin.access-grant',
  'plugin.access-revoke',
  'plugin.operations-list',
  'plugin.operation-show',
  'plugin.operation-acknowledge',
] as const;
/** Reads a restore-mode maintenance host can still serve; every mutation stays refused. */
export const LOCAL_PLUGIN_READ_METHODS = [
  'plugin.catalog',
  'plugin.inspect',
  'plugin.connections',
  'plugin.access-list',
  'plugin.operations-list',
  'plugin.operation-show',
] as const;

export type LocalPluginInstallState = 'installing' | 'installed' | 'interrupted' | 'corrupt';
export type LocalPluginConnectionState = 'active' | 'disconnected';
export type LocalPluginIdentityLabel = 'verified' | 'unverified';

export interface LocalPluginCatalogView {
  readonly pluginId: string;
  readonly publisher: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly transport: string;
  readonly endpoint: string;
  readonly authentication: string;
  readonly resourceConstraint: string;
  readonly readOnly: boolean;
  readonly tools: readonly string[];
  readonly operations: readonly string[];
  readonly manifestDigest: string;
  readonly adapter: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly installState: LocalPluginInstallState | null;
  readonly fileVerified: boolean;
}
export interface LocalPluginInstalledView {
  readonly pluginId: string;
  readonly version: string;
  readonly state: LocalPluginInstallState;
  readonly enabled: boolean;
  readonly verified: boolean;
  readonly manifestDigest: string;
  readonly adapter: string;
  readonly installedAt: string;
  readonly verifiedAt: string | null;
}
export interface LocalPluginEnableResult {
  readonly installed: LocalPluginInstalledView;
  readonly revokedGrants: number;
}
export interface LocalPluginConnectionView {
  readonly id: string;
  readonly name: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly adapterVersion: string;
  readonly endpoint: string;
  /** Environment variable NAME only, never its value. */
  readonly credentialReference: string;
  readonly accountLabel: string | null;
  readonly identity: string | null;
  readonly identityLabel: LocalPluginIdentityLabel;
  readonly state: LocalPluginConnectionState;
  readonly generation: number;
  readonly schemaDigest: string | null;
  readonly tools: readonly string[];
  readonly consented: boolean;
  readonly consentedGeneration: number | null;
  readonly consentedAt: string | null;
  readonly lastDiscoveryAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface LocalPluginConsentPreview {
  readonly connectionId: string;
  readonly name: string;
  readonly pluginId: string;
  readonly endpoint: string;
  readonly generation: number;
  readonly consented: boolean;
  readonly prompt: string;
}
export interface LocalPluginDiscoveryResult {
  readonly connection: LocalPluginConnectionView;
  readonly revokedGrants: number;
  readonly authorityChanged: boolean;
}
export interface LocalPluginDisconnectResult {
  readonly connection: LocalPluginConnectionView;
  readonly revokedGrants: number;
}
export interface LocalPluginGrantView {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly tools: readonly string[];
  readonly repository: string;
  readonly schemaDigest: string;
  readonly policyVersion: number;
  readonly visibility: string;
  readonly state: 'active' | 'revoked';
  readonly createdAt: string;
  readonly revokedAt: string | null;
}
export interface LocalPluginGrantScopeView {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly tools: readonly string[];
  readonly repository: string;
  readonly schemaDigest: string;
  readonly policyVersion: number;
}
export interface LocalPluginGrantPreview {
  readonly allowed: boolean;
  readonly refusal: string | null;
  readonly explanation: string;
  readonly groupVisibility: boolean;
  readonly participants: number;
  readonly scope: LocalPluginGrantScopeView | null;
}
export interface LocalPluginGrantRequest {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly tools: readonly string[];
  readonly repository: string;
  readonly acknowledgeGroupVisibility: boolean;
}
export interface LocalPluginCatalogQuery {
  readonly search?: string;
}
export interface LocalPluginInspectQuery {
  readonly pluginId: string;
}
export interface LocalPluginInstallRequest {
  readonly pluginId: string;
  readonly version?: string;
}
export interface LocalPluginConnectionAddRequest {
  readonly name: string;
  readonly pluginId: string;
  readonly credentialReference: string;
  readonly accountLabel?: string;
}
export interface LocalPluginConnectionQuery {
  readonly connectionId: string;
}
export interface LocalPluginConnectionRequest {
  readonly connectionId: string;
  readonly expectedGeneration: number;
}
export interface LocalPluginGrantFilter {
  readonly workspaceId?: string;
  readonly roomId?: string;
  readonly botId?: string;
}
export interface LocalPluginRevokeRequest {
  readonly grantId: string;
}

/** Durable operation states exposed to the owner; no secret or vendor payload. */
export type LocalPluginOperationState =
  'started' | 'observed' | 'failed' | 'not_started' | 'uncertain' | 'acknowledged';

export interface LocalPluginOperationView {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  /** Immutable endpoint binding recorded at admission. */
  readonly endpoint: string;
  readonly tool: string;
  readonly repository: string;
  readonly schemaDigest: string;
  readonly argumentsDigest: string;
  /** Bounded canonical arguments; never a credential value. */
  readonly arguments: string;
  readonly state: LocalPluginOperationState;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  /** Bounded model-visible result summary. */
  readonly resultSummary: string | null;
  readonly resultBytes: number | null;
  readonly truncated: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedReason: string | null;
}

export interface LocalPluginOperationListQuery {
  readonly workspaceId?: string;
  readonly roomId?: string;
  readonly botId?: string;
  readonly state?: LocalPluginOperationState;
  readonly limit?: number;
}

export interface LocalPluginOperationQuery {
  readonly operationId: string;
}

export interface LocalPluginOperationAcknowledgeRequest {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly reason?: string;
}
