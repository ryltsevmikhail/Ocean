/**
 * Strict validators for plugin grant requests, scopes and replies.
 */

import type {
  LocalPluginGrantFilter,
  LocalPluginGrantPreview,
  LocalPluginGrantRequest,
  LocalPluginGrantView,
  LocalPluginRevokeRequest,
} from './local-plugins.js';
import {
  bounded,
  only,
  pluginId,
  position,
  record,
  strings,
  sha,
} from './local-plugins-validate-base.js';

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
function isLocalPluginGrantScopeView(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    only(value, [
      'workspaceId',
      'roomId',
      'botId',
      'pluginId',
      'connectionId',
      'connectionGeneration',
      'tools',
      'repository',
      'schemaDigest',
      'policyVersion',
    ]) &&
    bounded(value['workspaceId'], 128) &&
    bounded(value['roomId'], 128) &&
    bounded(value['botId'], 128) &&
    pluginId(value['pluginId']) &&
    bounded(value['connectionId'], 128) &&
    position(value['connectionGeneration']) &&
    Number(value['connectionGeneration']) >= 1 &&
    strings(value['tools'], 16) &&
    bounded(value['repository'], 256) &&
    sha(value['schemaDigest']) &&
    position(value['policyVersion'])
  );
}

export function isLocalPluginGrantPreview(value: unknown): value is LocalPluginGrantPreview {
  if (!record(value)) return false;
  return (
    only(value, [
      'allowed',
      'refusal',
      'explanation',
      'groupVisibility',
      'participants',
      'scope',
    ]) &&
    typeof value['allowed'] === 'boolean' &&
    (value['refusal'] === null || bounded(value['refusal'], 64)) &&
    bounded(value['explanation'], 4096) &&
    typeof value['groupVisibility'] === 'boolean' &&
    position(value['participants']) &&
    (value['scope'] === null || isLocalPluginGrantScopeView(value['scope']))
  );
}
