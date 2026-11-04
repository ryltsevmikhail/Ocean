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

const operation = {
  id: 'op_1',
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId: 'conn_work',
  connectionGeneration: 2,
  endpoint: 'https://api.githubcopilot.com/mcp/',
  tool: 'list_issues',
  repository: 'team/api',
  schemaDigest: 'b'.repeat(64),
  argumentsDigest: 'c'.repeat(64),
  arguments: '{"owner":"team","repo":"api"}',
  state: 'uncertain' as const,
  outcomeCode: 'transport_failure',
  detail: 'connection lost after dispatch',
  resultSummary: null,
  resultBytes: null,
  truncated: false,
  revision: 2,
  createdAt: '2026-11-04T00:00:00.000Z',
  settledAt: '2026-11-04T00:00:00.000Z',
  acknowledgedAt: null,
  acknowledgedReason: null,
};

function harness() {
  const calls = { grant: [] as unknown[], revoke: 0, discover: 0, consent: 0, acknowledged: 0 };
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
    async pluginConnectionPreview() {
      return {
        connectionId: 'conn_work',
        name: 'work',
        pluginId: 'github',
        endpoint: 'https://api.githubcopilot.com/mcp/',
        generation: 2,
        consented: false,
        prompt: 'Ocean will ask https://api.githubcopilot.com/mcp/ for tool metadata once.',
      };
    },
    async pluginConnectionConsent() {
      calls.consent++;
      return {
        connectionId: 'conn_work',
        name: 'work',
        pluginId: 'github',
        endpoint: 'https://api.githubcopilot.com/mcp/',
        generation: 2,
        consented: true,
        prompt: 'consented',
      };
    },
    async pluginConnectionDiscover() {
      calls.discover++;
      return { connection, revokedGrants: 0, authorityChanged: false };
    },
    async pluginOperationsList() {
      return [operation];
    },
    async pluginOperationShow() {
      return operation;
    },
    async pluginOperationAcknowledge() {
      calls.acknowledged += 1;
      return { ...operation, state: 'acknowledged' as const, revision: 3 };
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
    expect(confirmed).toContain('Everyone in the group chat "Team"');
    expect(confirmed).toContain('Granted grant_1');
    expect(calls.grant).toHaveLength(1);
    const revoke = await plugins.handle('/plugin revoke grant_1');
    expect(revoke).toContain('revoked');
    expect(calls.revoke).toBe(1);
  });

  it('shows the endpoint prompt before recording metadata consent', async () => {
    const { plugins, calls } = harness();
    const prompt = await plugins.handle('/plugin consent conn_work 2');
    expect(prompt).toContain('https://api.githubcopilot.com/mcp/');
    expect(prompt).toContain('ack to record this consent');
    expect(calls.consent).toBe(0);
    const recorded = await plugins.handle('/plugin consent conn_work 2 ack');
    expect(recorded).toContain('Consent recorded');
    expect(calls.consent).toBe(1);
  });

  it('discovers only with an explicit generation argument', async () => {
    const { plugins, calls } = harness();
    expect(await plugins.handle('/plugin discover conn_work')).toContain('Use /plugin status');
    const result = await plugins.handle('/plugin discover conn_work 2');
    expect(result).toContain('Discovered 2 tools');
    expect(calls.discover).toBe(1);
  });
});

describe('room TUI /plugin operation journal', () => {
  it('lists and shows the durable operation journal', async () => {
    const { plugins } = harness();
    const list = await plugins.handle('/plugin operations');
    expect(list).toContain('op_1');
    expect(list).toContain('uncertain');
    expect(list).toContain('list_issues');
    const show = await plugins.handle('/plugin operation op_1');
    expect(show).toContain('operation op_1 uncertain');
    expect(show).toContain('transport_failure');
    expect(show).toContain('https://api.githubcopilot.com/mcp/');
  });

  it('acknowledges an uncertain operation only with an explicit revision', async () => {
    const { plugins, calls } = harness();
    expect(await plugins.handle('/plugin acknowledge op_1')).toContain('/plugin operations');
    expect(calls.acknowledged).toBe(0);
    const ack = await plugins.handle('/plugin acknowledge op_1 2 checked by hand');
    expect(ack).toContain('Acknowledged op_1');
    expect(ack).toContain('not retried');
    expect(calls.acknowledged).toBe(1);
  });
});
