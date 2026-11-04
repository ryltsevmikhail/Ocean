/**
 * Owner-facing catalog/install view mapping (plain data only).
 */

import type { PluginCatalogEntry } from '@runnets/domain';
import { PluginRefusedError } from './plugin-ports.js';
import type {
  PluginCatalogStorePort,
  PluginInstallState,
  PluginInstallStorePort,
  PluginInstalledVersion,
} from './plugin-ports.js';
export interface PluginInstalledView {
  readonly pluginId: string;
  readonly version: string;
  readonly state: PluginInstallState;
  readonly enabled: boolean;
  readonly verified: boolean;
  readonly manifestDigest: string;
  readonly adapter: string;
  readonly installedAt: string;
  readonly verifiedAt: string | null;
}

export interface PluginCatalogView {
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
  readonly installState: PluginInstallState | null;
  readonly fileVerified: boolean;
}

export interface PluginEnableResult {
  readonly installed: PluginInstalledView;
  /** Grants and pending confirmations revoked by this version switch. */
  readonly revokedGrants: number;
}

export interface PluginRecoveryReport {
  readonly interrupted: number;
  /** Corrupt rows whose private copy verified again at startup. */
  readonly repaired: number;
  readonly verified: number;
  readonly corrupt: number;
  readonly disabled: number;
  readonly revokedGrants: number;
}

export function pluginCatalogView(
  entry: PluginCatalogEntry,
  store: PluginCatalogStorePort,
  files: PluginInstallStorePort,
): PluginCatalogView {
  const installed = store.version(entry.pluginId, entry.version);
  const file = installed === null ? null : files.read(entry.pluginId, entry.version);
  return {
    pluginId: entry.pluginId,
    publisher: entry.publisher,
    version: entry.version,
    title: entry.title,
    description: entry.description,
    transport: entry.manifest.transport,
    endpoint: entry.manifest.endpoint,
    authentication: entry.manifest.authentication,
    resourceConstraint: entry.manifest.resourceConstraint,
    readOnly: entry.manifest.readOnly,
    tools: entry.manifest.operations.map((operation) => operation.tool),
    operations: entry.manifest.operations.map((operation) => operation.operation),
    manifestDigest: entry.manifestDigest,
    adapter: entry.adapter.adapter + ':' + String(entry.adapter.protocolVersion),
    installed: installed !== null && installed.state === 'installed',
    enabled: installed?.enabled === true,
    installState: installed?.state ?? null,
    fileVerified:
      installed !== null &&
      file !== null &&
      file.status === 'ok' &&
      file.sha256 === installed.manifestDigest,
  };
}

export function pluginInstalledView(record: PluginInstalledVersion): PluginInstalledView {
  return {
    pluginId: record.pluginId,
    version: record.version,
    state: record.state,
    enabled: record.enabled,
    verified: record.state === 'installed' && record.verifiedAt !== null,
    manifestDigest: record.manifestDigest,
    adapter: record.adapter.adapter + ':' + String(record.adapter.protocolVersion),
    installedAt: record.installedAt,
    verifiedAt: record.verifiedAt,
  };
}

export function pluginRefuse(code: string): PluginRefusedError {
  return new PluginRefusedError(code, 'plugin operation refused: ' + code);
}
