/**
 * Plugin backup inventory: authoritative metadata plus the private verified
 * manifest files a profile backup must include.
 *
 * The inventory never carries a credential value or reference: connections and
 * grants live in the database snapshot, and `credential_ref` remains an
 * environment variable NAME. A verified installed version must have its exact
 * manifest file archived, or the backup refuses explicitly.
 */

export type PluginBackupInstallState = 'installing' | 'installed' | 'interrupted' | 'corrupt';

export interface PluginBackupVersion {
  readonly pluginId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly state: PluginBackupInstallState;
  readonly enabled: boolean;
}

export interface PluginBackupInventory {
  readonly format: 1;
  readonly versions: readonly PluginBackupVersion[];
  readonly hash: string;
}

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;

export function validPluginBackupVersion(value: unknown): value is PluginBackupVersion {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['pluginId'] === 'string' &&
    ID.test(row['pluginId']) &&
    typeof row['version'] === 'string' &&
    VERSION.test(row['version']) &&
    typeof row['manifestDigest'] === 'string' &&
    DIGEST.test(row['manifestDigest']) &&
    ['installing', 'installed', 'interrupted', 'corrupt'].includes(String(row['state'])) &&
    typeof row['enabled'] === 'boolean'
  );
}

/** Bounded portable inventory used inside the backup asset catalog. */
export function validPluginBackupInventory(value: unknown): value is PluginBackupInventory {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row['format'] !== 1 || typeof row['hash'] !== 'string' || !DIGEST.test(row['hash']))
    return false;
  const versions = row['versions'];
  return (
    Array.isArray(versions) &&
    versions.length <= 64 &&
    versions.every((version) => validPluginBackupVersion(version)) &&
    new Set(
      versions.map((version: PluginBackupVersion) => version.pluginId + '@' + version.version),
    ).size === versions.length
  );
}

/** sha256 of `[]`, the canonical hash of an empty version list. */
export const EMPTY_PLUGIN_INVENTORY_HASH =
  '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';

export function emptyPluginBackupInventory(): PluginBackupInventory {
  return { format: 1, versions: [], hash: EMPTY_PLUGIN_INVENTORY_HASH };
}
