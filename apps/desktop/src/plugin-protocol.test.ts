import { describe, expect, it } from 'vitest';
import { commands, outputs } from './protocol.js';
import {
  pluginCatalogView,
  pluginConnectionView,
  pluginGrantPreview,
  pluginGrantView,
  pluginInstalled,
} from './plugin-protocol.js';

const catalog = {
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
  tools: ['list_issues'],
  operations: ['read_issues'],
  manifestDigest: 'a'.repeat(64),
  adapter: 'runnets-executor:1',
  installed: true,
  enabled: false,
  installState: 'installed',
  fileVerified: true,
};
const connection = {
  id: 'conn_work',
  name: 'work',
  pluginId: 'github',
  pluginVersion: '1.0.0',
  adapterVersion: 'runnets-executor:1:1.6.11',
  endpoint: 'https://api.githubcopilot.com/mcp/',
  credentialReference: 'OCEAN_GITHUB_WORK_TOKEN',
  accountLabel: null,
  identity: null,
  identityLabel: 'unverified',
  state: 'active',
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

describe('desktop plugin protocol', () => {
  it('accepts owner plugin commands and refuses credential values', () => {
    expect(
      commands.safeParse({
        op: 'plugin-connection-add',
        name: 'work',
        pluginId: 'github',
        credentialReference: 'OCEAN_GITHUB_WORK_TOKEN',
      }).success,
    ).toBe(true);
    expect(
      commands.safeParse({
        op: 'plugin-connection-add',
        name: 'work',
        pluginId: 'github',
        credentialReference: 'ghp_canaryValue',
      }).success,
    ).toBe(false);
    expect(
      commands.safeParse({
        op: 'plugin-access-grant',
        room: 'room_1',
        connectionId: 'conn_work',
        botId: 'bot_dev',
        repository: 'team/api',
        tools: ['list_issues'],
        acknowledgeGroupVisibility: true,
      }).success,
    ).toBe(true);
    expect(commands.safeParse({ op: 'plugin-install', pluginId: 'GitHub' }).success).toBe(false);
    expect(
      commands.safeParse({ op: 'plugin-connection-discover', connectionId: 'c' }).success,
    ).toBe(false);
  });

  it('validates the reply DTOs the renderer consumes', () => {
    expect(pluginCatalogView.safeParse(catalog).success).toBe(true);
    expect(pluginConnectionView.safeParse(connection).success).toBe(true);
    expect(
      pluginInstalled.safeParse({
        pluginId: 'github',
        version: '1.0.0',
        state: 'installed',
        enabled: false,
        verified: true,
        manifestDigest: 'a'.repeat(64),
        adapter: 'runnets-executor:1',
        installedAt: '2026-11-04T00:00:00.000Z',
        verifiedAt: '2026-11-04T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(outputs['plugin-catalog'].safeParse([catalog]).success).toBe(true);
    expect(
      pluginGrantPreview.safeParse({
        allowed: true,
        refusal: null,
        explanation: 'Everyone in the group chat will see this answer.',
        groupVisibility: true,
        participants: 3,
        scope: null,
      }).success,
    ).toBe(true);
    expect(
      pluginGrantView.safeParse({
        id: 'grant_1',
        workspaceId: 'ws_ocean',
        roomId: 'room_1',
        botId: 'bot_dev',
        pluginId: 'github',
        connectionId: 'conn_work',
        connectionGeneration: 1,
        tools: ['list_issues'],
        repository: 'team/api',
        schemaDigest: 'a'.repeat(64),
        policyVersion: 1,
        visibility: 'Everyone in the group chat',
        state: 'active',
        createdAt: '2026-11-04T00:00:00.000Z',
        revokedAt: null,
      }).success,
    ).toBe(true);
  });
});
