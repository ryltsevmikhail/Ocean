/**
 * Strict validators for the local-runtime plugin contract.
 *
 * Every value that crosses the authenticated socket passes one of these guards
 * before the runtime or a client trusts it. No validator accepts a credential
 * VALUE where a reference name is required.
 */

import { localRuntimeRecord } from './local-runtime.js';
import type {
  LocalPluginCatalogQuery,
  LocalPluginCatalogView,
  LocalPluginConnectionAddRequest,
  LocalPluginConnectionQuery,
  LocalPluginConnectionRequest,
  LocalPluginConnectionView,
  LocalPluginConsentPreview,
  LocalPluginDiscoveryResult,
  LocalPluginDisconnectResult,
  LocalPluginEnableResult,
  LocalPluginGrantFilter,
  LocalPluginGrantPreview,
  LocalPluginGrantRequest,
  LocalPluginGrantView,
  LocalPluginInspectQuery,
  LocalPluginInstallRequest,
  LocalPluginInstalledView,
  LocalPluginInstallState,
  LocalPluginRevokeRequest,
} from './local-plugins.js';

const record = localRuntimeRecord;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const optionalBounded = (value: unknown, max: number): boolean =>
  value === undefined || bounded(value, max);
const position = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const strings = (value: unknown, max: number): value is readonly string[] =>
  Array.isArray(value) && value.length <= max && value.every((entry) => bounded(entry, 128));
const sha = (value: unknown): value is string => typeof value === 'string' && digest(value);
const pluginId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const version = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/.test(value);
const connectionName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const credentialReference = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value);

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const names = Object.keys(value);
  return names.length === keys.length && names.every((name) => keys.includes(name));
}
export function isLocalPluginCatalogQuery(value: unknown): value is LocalPluginCatalogQuery {
  return (
    record(value) &&
    (only(value, []) || only(value, ['search'])) &&
    optionalBounded(value['search'], 128)
  );
}
export function isLocalPluginInspectQuery(value: unknown): value is LocalPluginInspectQuery {
  return record(value) && only(value, ['pluginId']) && pluginId(value['pluginId']);
}
export function isLocalPluginInstallRequest(value: unknown): value is LocalPluginInstallRequest {
  return (
    record(value) &&
    (only(value, ['pluginId']) || only(value, ['pluginId', 'version'])) &&
    pluginId(value['pluginId']) &&
    (value['version'] === undefined || version(value['version']))
  );
}
export function isLocalPluginConnectionAddRequest(
  value: unknown,
): value is LocalPluginConnectionAddRequest {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (!(
    only(value, ['name', 'pluginId', 'credentialReference']) ||
    only(value, ['name', 'pluginId', 'credentialReference', 'accountLabel'])
  ))
    return false;
  return (
    keys.length > 0 &&
    connectionName(value['name']) &&
    pluginId(value['pluginId']) &&
    credentialReference(value['credentialReference']) &&
    optionalBounded(value['accountLabel'], 256)
  );
}
export function isLocalPluginConnectionQuery(value: unknown): value is LocalPluginConnectionQuery {
  return record(value) && only(value, ['connectionId']) && bounded(value['connectionId'], 128);
}
export function isLocalPluginConnectionRequest(
  value: unknown,
): value is LocalPluginConnectionRequest {
  return (
    record(value) &&
    only(value, ['connectionId', 'expectedGeneration']) &&
    bounded(value['connectionId'], 128) &&
    position(value['expectedGeneration']) &&
    Number(value['expectedGeneration']) >= 1
  );
}
export function isLocalPluginGrantRequest(value: unknown): value is LocalPluginGrantRequest {
  return (
    record(value) &&
    only(value, [
      'workspaceId',
      'roomId',
      'botId',
      'pluginId',
      'connectionId',
      'tools',
      'repository',
      'acknowledgeGroupVisibility',
    ]) &&
    bounded(value['workspaceId'], 128) &&
    bounded(value['roomId'], 128) &&
    bounded(value['botId'], 128) &&
    pluginId(value['pluginId']) &&
    bounded(value['connectionId'], 128) &&
    Array.isArray(value['tools']) &&
    value['tools'].length >= 1 &&
    value['tools'].length <= 16 &&
    value['tools'].every((tool) => bounded(tool, 128)) &&
    typeof value['repository'] === 'string' &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9._-]{1,100}$/.test(value['repository']) &&
    typeof value['acknowledgeGroupVisibility'] === 'boolean'
  );
}
export function isLocalPluginGrantFilter(value: unknown): value is LocalPluginGrantFilter {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => ['workspaceId', 'roomId', 'botId'].includes(key))) return false;
  return keys.every((key) => bounded(value[key], 128));
}
export function isLocalPluginRevokeRequest(value: unknown): value is LocalPluginRevokeRequest {
  return record(value) && only(value, ['grantId']) && bounded(value['grantId'], 128);
}

const installState = (value: unknown): value is LocalPluginInstallState =>
  value === 'installing' || value === 'installed' || value === 'interrupted' || value === 'corrupt';
export function isLocalPluginInstalledView(value: unknown): value is LocalPluginInstalledView {
  return (
    record(value) &&
    pluginId(value['pluginId']) &&
    version(value['version']) &&
    installState(value['state']) &&
    typeof value['enabled'] === 'boolean' &&
    typeof value['verified'] === 'boolean' &&
    sha(value['manifestDigest']) &&
    bounded(value['adapter'], 128) &&
    bounded(value['installedAt'], 64) &&
    (value['verifiedAt'] === null || bounded(value['verifiedAt'], 64))
  );
}
export function isLocalPluginEnableResult(value: unknown): value is LocalPluginEnableResult {
  return (
    record(value) &&
    isLocalPluginInstalledView(value['installed']) &&
    position(value['revokedGrants'])
  );
}
export function isLocalPluginCatalogView(value: unknown): value is LocalPluginCatalogView {
  return (
    record(value) &&
    pluginId(value['pluginId']) &&
    bounded(value['publisher'], 128) &&
    version(value['version']) &&
    bounded(value['title'], 256) &&
    bounded(value['description'], 4096) &&
    bounded(value['transport'], 64) &&
    bounded(value['endpoint'], 2048) &&
    bounded(value['authentication'], 64) &&
    bounded(value['resourceConstraint'], 64) &&
    typeof value['readOnly'] === 'boolean' &&
    strings(value['tools'], 64) &&
    strings(value['operations'], 64) &&
    sha(value['manifestDigest']) &&
    bounded(value['adapter'], 128) &&
    typeof value['installed'] === 'boolean' &&
    typeof value['enabled'] === 'boolean' &&
    (value['installState'] === null || installState(value['installState'])) &&
    typeof value['fileVerified'] === 'boolean'
  );
}
export function isLocalPluginCatalogViews(
  value: unknown,
): value is readonly LocalPluginCatalogView[] {
  return Array.isArray(value) && value.length <= 64 && value.every(isLocalPluginCatalogView);
}
export function isLocalPluginConnectionView(value: unknown): value is LocalPluginConnectionView {
  return (
    record(value) &&
    bounded(value['id'], 128) &&
    connectionName(value['name']) &&
    pluginId(value['pluginId']) &&
    version(value['pluginVersion']) &&
    bounded(value['adapterVersion'], 128) &&
    bounded(value['endpoint'], 2048) &&
    credentialReference(value['credentialReference']) &&
    (value['accountLabel'] === null || bounded(value['accountLabel'], 256)) &&
    (value['identity'] === null || bounded(value['identity'], 256)) &&
    (value['identityLabel'] === 'verified' || value['identityLabel'] === 'unverified') &&
    (value['state'] === 'active' || value['state'] === 'disconnected') &&
    position(value['generation']) &&
    Number(value['generation']) >= 1 &&
    (value['schemaDigest'] === null || sha(value['schemaDigest'])) &&
    strings(value['tools'], 256) &&
    typeof value['consented'] === 'boolean' &&
    (value['consentedGeneration'] === null || position(value['consentedGeneration'])) &&
    (value['consentedAt'] === null || bounded(value['consentedAt'], 64)) &&
    (value['lastDiscoveryAt'] === null || bounded(value['lastDiscoveryAt'], 64)) &&
    bounded(value['createdAt'], 64) &&
    bounded(value['updatedAt'], 64)
  );
}
export function isLocalPluginConnections(
  value: unknown,
): value is readonly LocalPluginConnectionView[] {
  return Array.isArray(value) && value.length <= 32 && value.every(isLocalPluginConnectionView);
}
export function isLocalPluginConsentPreview(value: unknown): value is LocalPluginConsentPreview {
  return (
    record(value) &&
    bounded(value['connectionId'], 128) &&
    connectionName(value['name']) &&
    pluginId(value['pluginId']) &&
    bounded(value['endpoint'], 2048) &&
    position(value['generation']) &&
    typeof value['consented'] === 'boolean' &&
    bounded(value['prompt'], 4096)
  );
}
export function isLocalPluginDiscoveryResult(value: unknown): value is LocalPluginDiscoveryResult {
  return (
    record(value) &&
    isLocalPluginConnectionView(value['connection']) &&
    position(value['revokedGrants']) &&
    typeof value['authorityChanged'] === 'boolean'
  );
}
export function isLocalPluginDisconnectResult(
  value: unknown,
): value is LocalPluginDisconnectResult {
  return (
    record(value) &&
    isLocalPluginConnectionView(value['connection']) &&
    position(value['revokedGrants'])
  );
}
export function isLocalPluginGrantView(value: unknown): value is LocalPluginGrantView {
  return (
    record(value) &&
    bounded(value['id'], 128) &&
    bounded(value['workspaceId'], 128) &&
    bounded(value['roomId'], 128) &&
    bounded(value['botId'], 128) &&
    pluginId(value['pluginId']) &&
    bounded(value['connectionId'], 128) &&
    position(value['connectionGeneration']) &&
    strings(value['tools'], 16) &&
    bounded(value['repository'], 256) &&
    sha(value['schemaDigest']) &&
    position(value['policyVersion']) &&
    bounded(value['visibility'], 4096) &&
    (value['state'] === 'active' || value['state'] === 'revoked') &&
    bounded(value['createdAt'], 64) &&
    (value['revokedAt'] === null || bounded(value['revokedAt'], 64))
  );
}
export function isLocalPluginGrants(value: unknown): value is readonly LocalPluginGrantView[] {
  return Array.isArray(value) && value.length <= 200 && value.every(isLocalPluginGrantView);
}
export function isLocalPluginGrantPreview(value: unknown): value is LocalPluginGrantPreview {
  if (!record(value)) return false;
  return (
    typeof value['allowed'] === 'boolean' &&
    (value['refusal'] === null || bounded(value['refusal'], 64)) &&
    bounded(value['explanation'], 4096) &&
    typeof value['groupVisibility'] === 'boolean' &&
    position(value['participants']) &&
    (value['scope'] === null ||
      (record(value['scope']) &&
        bounded(value['scope']['repository'], 256) &&
        strings(value['scope']['tools'], 16) &&
        sha(value['scope']['schemaDigest'])))
  );
}
