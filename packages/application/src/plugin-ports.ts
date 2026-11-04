/**
 * Service-plugin ports.
 *
 * Ocean owns the catalog, installed versions, named connections, discovery
 * consent and exact grants. These ports are the only seams the application
 * services use; SQLite and the private filesystem implement them. No port ever
 * carries a credential value: connections keep an environment variable NAME.
 */

import type {
  PluginAdapterCompatibility,
  PluginAdapterIdentity,
  PluginConnectionState,
  PluginGrantRecord,
  PluginManifest,
} from '@runnets/domain';
import type { Clock } from './ports.js';
import type {
  ServicePluginAccountIdentity,
  ServicePluginTool,
} from './service-plugin-transport.js';

/** Lifecycle of one installed declarative version. Only `installed` can be enabled. */
export type PluginInstallState = 'installing' | 'installed' | 'interrupted' | 'corrupt';

export interface PluginInstalledVersion {
  readonly pluginId: string;
  readonly version: string;
  readonly publisher: string;
  readonly title: string;
  readonly manifest: PluginManifest;
  readonly manifestDigest: string;
  readonly adapter: PluginAdapterCompatibility;
  readonly state: PluginInstallState;
  readonly enabled: boolean;
  /** SHA-256 of the persisted manifest file; null until the private copy verified. */
  readonly fileDigest: string | null;
  readonly installedAt: string;
  readonly verifiedAt: string | null;
}

/** One verified file of the private copy, relative to the version directory. */
export interface PluginInstalledFile {
  readonly relativePath: 'manifest.json';
  readonly sha256: string;
  readonly bytes: number;
}

/** Durable catalog state; every mutation is one SQLite statement or transaction. */
export interface PluginCatalogStorePort {
  /** Distinct plugin ids with at least one recorded version. */
  plugins(): readonly string[];
  versions(pluginId: string): readonly PluginInstalledVersion[];
  version(pluginId: string, version: string): PluginInstalledVersion | null;
  enabled(pluginId: string): PluginInstalledVersion | null;
  /**
   * Persist install intent before the filesystem effect. A corrupt or
   * interrupted row may be replaced explicitly; a verified install is never
   * silently overwritten.
   */
  beginInstall(version: PluginInstalledVersion): void;
  /** Mark the verified copy installed and disabled; false if the intent disappeared. */
  markVerified(
    pluginId: string,
    version: string,
    file: PluginInstalledFile,
    verifiedAt: string,
  ): boolean;
  setState(pluginId: string, version: string, state: PluginInstallState): void;
  /**
   * Persist enabled/disabled. When `revoke` is true, all active grants and
   * pending confirmations of the plugin are revoked in the same transaction.
   */
  setEnabled(
    pluginId: string,
    version: string,
    enabled: boolean,
    at: string,
    revoke: boolean,
  ): number;
}

export type PluginInstalledFileRead =
  | { readonly status: 'ok'; readonly bytes: number; readonly sha256: string }
  | { readonly status: 'missing' | 'unreadable' | 'insecure'; readonly reason: string };

/** Private 0700/0600 copy inside the profile; publication is atomic (temp + rename). */
export interface PluginInstallStorePort {
  publish(pluginId: string, version: string, manifest: PluginManifest): PluginInstalledFile;
  /**
   * Explicit owner repair: atomically replace an existing unverified version
   * directory with a fresh verified copy of the pinned manifest bytes.
   */
  repair(pluginId: string, version: string, manifest: PluginManifest): PluginInstalledFile;
  read(pluginId: string, version: string): PluginInstalledFileRead;
}

export interface PluginConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly pluginId: string;
  /** Installed plugin version this connection was last reconciled with. */
  readonly pluginVersion: string;
  /** Adapter build identity (`adapter:protocol:sdk`) this connection was observed under. */
  readonly adapterVersion: string;
  readonly endpoint: string;
  /** Environment variable NAME only; the value is never read by this service. */
  readonly credentialReference: string;
  readonly accountLabel: string | null;
  readonly identity: string | null;
  readonly identityVerified: boolean;
  readonly state: PluginConnectionState;
  readonly generation: number;
  /** Published only from one successful complete transport discovery. */
  readonly schemaDigest: string | null;
  readonly tools: readonly ServicePluginTool[] | null;
  readonly consentedGeneration: number | null;
  readonly consentedAt: string | null;
  readonly lastDiscoveryAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PluginConnectionPatch {
  readonly endpoint?: string;
  readonly credentialReference?: string;
  readonly accountLabel?: string | null;
  readonly pluginVersion?: string;
  readonly adapterVersion?: string;
}

export interface PluginDiscoveryConsentRecord {
  readonly connectionId: string;
  readonly generation: number;
  readonly endpoint: string;
  readonly consentedAt: string;
  /** Set when the consent authorized one discovery pass; it is single-use. */
  readonly usedAt: string | null;
}

export interface PluginDiscoveryPublication {
  readonly connectionId: string;
  readonly expectedGeneration: number;
  readonly pluginVersion: string;
  readonly adapterVersion: string;
  readonly schemaDigest: string;
  readonly tools: readonly ServicePluginTool[];
  readonly identity: ServicePluginAccountIdentity;
  readonly discoveredAt: string;
}

export interface PluginDiscoveryPublicationResult {
  readonly connection: PluginConnectionRecord;
  /** True when the observed authority moved; grants and confirmations were revoked. */
  readonly authorityChanged: boolean;
  readonly revokedGrants: number;
}

export interface PluginConnectionStorePort {
  list(): readonly PluginConnectionRecord[];
  get(id: string): PluginConnectionRecord | null;
  /** Insert a fresh active connection; duplicate `(pluginId, name)` throws `connection_exists`. */
  add(record: PluginConnectionRecord): void;
  /** Atomic generation bump + patch + grant/confirmation revocation for a changed authority. */
  change(
    connectionId: string,
    expectedGeneration: number,
    patch: PluginConnectionPatch,
    at: string,
  ): PluginConnectionRecord;
  consent(record: PluginDiscoveryConsentRecord): void;
  consents(connectionId: string): readonly PluginDiscoveryConsentRecord[];
  /**
   * Atomically consume the unused consent for this exact generation+endpoint.
   * False means the owner must explicitly consent again before any discovery.
   */
  consumeConsent(connectionId: string, generation: number, endpoint: string, at: string): boolean;
  /** Publish exclusively from a complete discovery; never from a refusal or a snapshot. */
  publishDiscovery(input: PluginDiscoveryPublication): PluginDiscoveryPublicationResult;
  /**
   * Idempotent: a disconnected connection stays disconnected; the returned count
   * is the number of active grants revoked by this call (never fabricated).
   */
  disconnect(
    connectionId: string,
    at: string,
  ): { readonly connection: PluginConnectionRecord; readonly revokedGrants: number };
  /** Restored profiles: every connection and grant becomes inert before admission. */
  invalidateRestored(at: string): void;
}

export interface PluginGrantScopeFacts {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly tools: readonly string[];
  readonly repository: string;
  readonly schemaDigest: string;
}

export interface PluginRoomFacts {
  readonly id: string;
  readonly kind: 'direct' | 'group';
  readonly title: string | null;
  readonly participantCount: number;
}

/** One SQLite immediate transaction: membership, authority and grant creation. */
export interface PluginAccessTransaction {
  member(workspaceId: string, roomId: string, botId: string): boolean;
  room(roomId: string): PluginRoomFacts | null;
  connection(connectionId: string): PluginConnectionRecord | null;
  /** Currently enabled, verified installed version of the plugin. */
  enabledVersion(pluginId: string): PluginInstalledVersion | null;
  activeGrants(scope: PluginGrantScopeFacts): readonly PluginGrantRecord[];
  grant(id: string): PluginGrantRecord | null;
  putGrant(record: PluginGrantRecord): void;
  putGrantAndRevokePrevious(record: PluginGrantRecord, at: string): void;
}

export interface PluginAccessStorePort {
  atomic<T>(work: (tx: PluginAccessTransaction) => T): T;
  grants(filter?: {
    readonly workspaceId?: string;
    readonly roomId?: string;
    readonly botId?: string;
    readonly pluginId?: string;
  }): readonly PluginGrantRecord[];
  /** Immediate durable revoke; false when the grant is unknown or already revoked. */
  revoke(grantId: string, at: string): boolean;
}

/**
 * Admission transaction/port live in `plugin-admission-ports.ts`; re-exported
 * here so existing imports keep one public entry.
 */
export type {
  PluginAdmissionSettlement,
  PluginAdmissionStorePort,
  PluginAdmissionTransaction,
} from './plugin-admission-ports.js';

/** Reads only whether the owner-configured environment reference is present. */
export interface PluginCredentialReferencePort {
  /** True when the environment variable NAME resolves to a non-empty value. */
  available(reference: string): boolean;
}

/** Installed-version reader shared by the connection and access services. */
export interface PluginVersionReadPort {
  versions(pluginId: string): readonly PluginInstalledVersion[];
  enabled(pluginId: string): PluginInstalledVersion | null;
}

/** Service context: deterministic time/identity and a host-injected digest. */
export interface PluginServiceContext {
  readonly clock: Clock;
  readonly nextId: () => string;
  readonly sha256: (text: string) => string;
  /** False on a restored/maintenance host: reads stay, owner mutations refuse. */
  readonly mutationsAllowed?: boolean;
  readonly restored?: boolean;
}

/** Typed refusal carrying a stable lowercase code; no secret or vendor body. */
export class PluginRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PluginRefusedError';
    this.code = code;
  }
}

/** Adapter build identity encoded exactly as a connection stores it. */
export function pluginAdapterVersion(identity: PluginAdapterIdentity): string {
  return [identity.adapter, identity.protocolVersion, identity.sdkVersion].join(':');
}

/** Credential reference check that never touches the value. */
export function pluginCredentialPresent(
  credentials: PluginCredentialReferencePort,
  reference: string,
): boolean {
  return credentials.available(reference) === true;
}
