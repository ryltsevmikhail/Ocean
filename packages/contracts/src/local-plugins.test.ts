import { describe, expect, it } from 'vitest';
import {
  isLocalPluginCatalogQuery,
  isLocalPluginCatalogView,
  isLocalPluginConnectionAddRequest,
  isLocalPluginConnectionRequest,
  isLocalPluginConnectionView,
  isLocalPluginConnections,
  isLocalPluginConsentPreview,
  isLocalPluginDiscoveryResult,
  isLocalPluginGrantFilter,
  isLocalPluginGrantPreview,
  isLocalPluginGrantRequest,
  isLocalPluginGrantView,
  isLocalPluginGrants,
  isLocalPluginInspectQuery,
  isLocalPluginInstallRequest,
  isLocalPluginRevokeRequest,
} from './local-plugins-validate.js';
import { LOCAL_PLUGIN_METHODS, LOCAL_PLUGIN_READ_METHODS } from './local-plugins.js';

const digest = 'a'.repeat(64);
const connection = {
  id: 'conn_work',
  name: 'work',
  pluginId: 'github',
  pluginVersion: '1.0.0',
  adapterVersion: 'runnets-executor:1:1.6.11',
  endpoint: 'https://api.githubcopilot.com/mcp/',
  credentialReference: 'OCEAN_GITHUB_WORK_TOKEN',
  accountLabel: 'Work',
  identity: null,
  identityLabel: 'unverified' as const,
  state: 'active' as const,
  generation: 1,
  schemaDigest: null,
  tools: [],
  consented: false,
  consentedGeneration: null,
  consentedAt: null,
  lastDiscoveryAt: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};
const catalogView = {
  pluginId: 'github',
  publisher: 'github',
  version: '1.0.0',
  title: 'GitHub issues (read-only)',
  description: 'frozen card',
  transport: 'mcp-streamable-http',
  endpoint: 'https://api.githubcopilot.com/mcp/',
  authentication: 'environment-reference',
  resourceConstraint: 'repository',
  readOnly: true,
  tools: ['list_issues', 'issue_read'],
  operations: ['read_issues', 'read_issue'],
  manifestDigest: digest,
  adapter: 'runnets-executor:1',
  installed: false,
  enabled: false,
  installState: null,
  fileVerified: false,
};
const grant = {
  id: 'grant_1',
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId: 'conn_work',
  connectionGeneration: 1,
  tools: ['list_issues'],
  repository: 'team/api',
  schemaDigest: digest,
  policyVersion: 1,
  visibility: 'Everyone in the group chat',
  state: 'active' as const,
  createdAt: '2026-11-04T00:00:00.000Z',
  revokedAt: null,
};
const grantRequest = {
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId: 'conn_work',
  tools: ['list_issues'],
  repository: 'team/api',
  acknowledgeGroupVisibility: true,
};

describe('local plugin contract', () => {
  it('lists owner methods and read-only maintenance methods', () => {
    expect(LOCAL_PLUGIN_METHODS).toContain('plugin.install');
    expect(LOCAL_PLUGIN_METHODS).toContain('plugin.access-grant');
    expect(LOCAL_PLUGIN_READ_METHODS.every((method) => LOCAL_PLUGIN_METHODS.includes(method))).toBe(
      true,
    );
    expect(LOCAL_PLUGIN_READ_METHODS).not.toContain('plugin.install');
    expect(LOCAL_PLUGIN_READ_METHODS).not.toContain('plugin.access-grant');
  });

  it('validates wire requests with bounded fields only', () => {
    expect(isLocalPluginCatalogQuery({})).toBe(true);
    expect(isLocalPluginCatalogQuery({ search: 'git' })).toBe(true);
    expect(isLocalPluginCatalogQuery({ search: 'x'.repeat(129) })).toBe(false);
    expect(isLocalPluginInspectQuery({ pluginId: 'github' })).toBe(true);
    expect(isLocalPluginInspectQuery({ pluginId: 'GitHub' })).toBe(false);
    expect(isLocalPluginInstallRequest({ pluginId: 'github' })).toBe(true);
    expect(isLocalPluginInstallRequest({ pluginId: 'github', version: '1.0.0' })).toBe(true);
    expect(isLocalPluginInstallRequest({ pluginId: 'github', key: 'sk-leak' })).toBe(false);
    expect(
      isLocalPluginConnectionAddRequest({
        name: 'work',
        pluginId: 'github',
        credentialReference: 'OCEAN_GITHUB_WORK_TOKEN',
      }),
    ).toBe(true);
    // A credential VALUE cannot pass as a reference.
    expect(
      isLocalPluginConnectionAddRequest({
        name: 'work',
        pluginId: 'github',
        credentialReference: 'ghp_secretValue',
      }),
    ).toBe(false);
    expect(
      isLocalPluginConnectionRequest({ connectionId: 'conn_work', expectedGeneration: 1 }),
    ).toBe(true);
    expect(
      isLocalPluginConnectionRequest({ connectionId: 'conn_work', expectedGeneration: 0 }),
    ).toBe(false);
    expect(isLocalPluginGrantRequest(grantRequest)).toBe(true);
    expect(isLocalPluginGrantRequest({ ...grantRequest, tools: [] })).toBe(false);
    expect(isLocalPluginGrantRequest({ ...grantRequest, repository: 'team' })).toBe(false);
    expect(isLocalPluginGrantRequest({ ...grantRequest, secret: 'x' })).toBe(false);
    expect(isLocalPluginGrantFilter({ roomId: 'room_1' })).toBe(true);
    expect(isLocalPluginGrantFilter({ secret: 'x' })).toBe(false);
    expect(isLocalPluginRevokeRequest({ grantId: 'grant_1' })).toBe(true);
    expect(isLocalPluginRevokeRequest({})).toBe(false);
  });

  it('validates metadata replies and rejects a secret-shaped field', () => {
    expect(isLocalPluginCatalogView(catalogView)).toBe(true);
    expect(isLocalPluginCatalogView({ ...catalogView, tools: ['x'.repeat(129)] })).toBe(false);
    expect(isLocalPluginConnectionView(connection)).toBe(true);
    expect(isLocalPluginConnections([connection])).toBe(true);
    expect(
      isLocalPluginConsentPreview({
        connectionId: 'conn_work',
        name: 'work',
        pluginId: 'github',
        endpoint: 'https://api.githubcopilot.com/mcp/',
        generation: 1,
        consented: false,
        prompt: 'Ocean will ask the service for metadata once.',
      }),
    ).toBe(true);
    expect(
      isLocalPluginDiscoveryResult({ connection, revokedGrants: 0, authorityChanged: true }),
    ).toBe(true);
    expect(isLocalPluginGrantView(grant)).toBe(true);
    expect(isLocalPluginGrants([grant])).toBe(true);
    expect(
      isLocalPluginGrantPreview({
        allowed: true,
        refusal: null,
        explanation: 'Everyone in the group chat "Team" will see this answer.',
        groupVisibility: true,
        participants: 3,
        scope: null,
      }),
    ).toBe(true);
    expect(
      isLocalPluginGrantPreview({
        allowed: false,
        refusal: 'member_required',
        explanation: 'refused',
        groupVisibility: false,
        participants: 0,
        scope: null,
      }),
    ).toBe(true);
  });
});
