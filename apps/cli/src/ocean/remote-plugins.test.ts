import { describe, expect, it } from 'vitest';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { RemotePlugins } from './remote-plugins.js';

const catalogEntry = {
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
  manifestDigest: 'a'.repeat(64),
  adapter: 'runnets-executor:1',
  installed: true,
  enabled: true,
  installState: 'installed' as const,
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
  accountLabel: 'Work',
  identity: 'octocat',
  identityLabel: 'verified' as const,
  state: 'active' as const,
  generation: 2,
  schemaDigest: 'b'.repeat(64),
  tools: ['list_issues', 'issue_read'],
  consented: true,
  consentedGeneration: 2,
  consentedAt: '2026-11-04T00:00:00.000Z',
  lastDiscoveryAt: '2026-11-04T00:00:00.000Z',
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};
const explanation =
  'Everyone in the group chat "Team" (3 participants) including every bot in it will see this answer.';

function harness() {
  const calls = { grant: [] as unknown[], revoke: 0, discover: 0 };
  const client = {
    async pluginCatalog() {
      return [catalogEntry];
    },
    async pluginConnections() {
      return [connection];
    },
    async pluginAccessList() {
      return [];
    },
    async pluginAccessPreview() {
      return {
        allowed: true,
        refusal: null,
        explanation,
        groupVisibility: true,
        participants: 3,
        scope: null,
      };
    },
    async pluginAccessGrant(request: unknown) {
      calls.grant.push(request);
      return {
        id: 'grant_1',
        workspaceId: 'ws_ocean',
        roomId: 'room_1',
        botId: 'bot_dev',
        pluginId: 'github',
        connectionId: 'conn_work',
        connectionGeneration: 2,
        tools: ['list_issues'],
        repository: 'team/api',
        schemaDigest: 'b'.repeat(64),
        policyVersion: 1,
        visibility: explanation,
        state: 'active',
        createdAt: '2026-11-04T00:00:00.000Z',
        revokedAt: null,
      };
    },
    async pluginAccessRevoke() {
      calls.revoke++;
      return { id: 'grant_1', state: 'revoked' };
    },
    async pluginConnectionDiscover() {
      calls.discover++;
      return { connection, revokedGrants: 0, authorityChanged: false };
    },
  } as unknown as LocalRuntimeClient;
  const connectionLike = {
    withClient: async <T>(work: (client: LocalRuntimeClient) => Promise<T>) => work(client),
  };
  const plugins = new RemotePlugins(connectionLike, { workspaceId: 'ws_ocean', roomId: 'room_1' });
  return { plugins, calls };
}

describe('room TUI /plugin commands', () => {
  it('ignores drafts that are not plugin commands', async () => {
    const { plugins } = harness();
    expect(await plugins.handle('hello')).toBeNull();
    expect(await plugins.handle('/broadcast hi')).toBeNull();
  });

  it('shows read-only state for catalog, connections and grants', async () => {
    const { plugins } = harness();
    const status = await plugins.handle('/plugin status');
    expect(status).toContain('github@1.0.0 enabled');
    expect(status).toContain('connection work gen=2');
    expect(status).toContain('credential=OCEAN_GITHUB_WORK_TOKEN');
  });

  it('prints the group visibility explanation and withholds the grant until ack', async () => {
    const { plugins, calls } = harness();
    const first = await plugins.handle('/plugin grant conn_work bot_dev team/api list_issues');
    expect(first).toContain('Everyone in the group chat "Team"');
    expect(first).toContain('ack to confirm');
    expect(calls.grant).toHaveLength(0);
    const confirmed = await plugins.handle(
      '/plugin grant conn_work bot_dev team/api list_issues ack',
    );
    expect(confirmed).toContain('Granted grant_1');
    expect(calls.grant).toHaveLength(1);
    const revoke = await plugins.handle('/plugin revoke grant_1');
    expect(revoke).toContain('revoked');
    expect(calls.revoke).toBe(1);
  });

  it('discovers only with an explicit generation argument', async () => {
    const { plugins, calls } = harness();
    expect(await plugins.handle('/plugin discover conn_work')).toContain('Use /plugin status');
    const result = await plugins.handle('/plugin discover conn_work 2');
    expect(result).toContain('Discovered 2 tools');
    expect(calls.discover).toBe(1);
  });
});
