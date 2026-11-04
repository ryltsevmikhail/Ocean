import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { oceanArguments } from './arguments.js';
import { runPluginCommand } from './plugin-command.js';

const view = {
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
  endpoint: view.endpoint,
  credentialReference: 'OCEAN_GITHUB_WORK_TOKEN',
  accountLabel: 'Work',
  identity: null,
  identityLabel: 'unverified' as const,
  state: 'active' as const,
  generation: 2,
  schemaDigest: 'b'.repeat(64),
  tools: ['list_issues'],
  consented: true,
  consentedGeneration: 2,
  consentedAt: '2026-11-04T00:00:00.000Z',
  lastDiscoveryAt: '2026-11-04T00:00:00.000Z',
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};
const grant = {
  id: 'grant_1',
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId: connection.id,
  connectionGeneration: 2,
  tools: ['list_issues'],
  repository: 'team/api',
  schemaDigest: 'b'.repeat(64),
  policyVersion: 1,
  visibility: 'Everyone in the group chat "Team" (3 participants) will see this answer.',
  state: 'active' as const,
  createdAt: '2026-11-04T00:00:00.000Z',
  revokedAt: null,
};
const explanation =
  'Everyone in the group chat "Team" (3 participants) including every bot in it will see this answer.';

function fake() {
  const calls = {
    install: 0,
    enable: 0,
    add: [] as unknown[],
    grant: [] as unknown[],
    revoke: 0,
    discover: 0,
  };
  const client = {
    async pluginCatalog() {
      return [view];
    },
    async pluginInspect() {
      return view;
    },
    async pluginInstall() {
      calls.install++;
      return { ...view, enabled: false };
    },
    async pluginEnable() {
      calls.enable++;
      return { installed: view, revokedGrants: 0 };
    },
    async pluginDisable() {
      return view;
    },
    async pluginConnections() {
      return [connection];
    },
    async pluginConnectionAdd(request: unknown) {
      calls.add.push(request);
      return connection;
    },
    async pluginConnectionPreview() {
      return {
        connectionId: connection.id,
        name: 'work',
        pluginId: 'github',
        endpoint: view.endpoint,
        generation: 2,
        consented: false,
        prompt: 'Ocean will ask https://api.githubcopilot.com/mcp/ for tool metadata once.',
      };
    },
    async pluginConnectionConsent() {
      return {
        connectionId: connection.id,
        name: 'work',
        pluginId: 'github',
        endpoint: view.endpoint,
        generation: 2,
        consented: true,
        prompt: 'consented',
      };
    },
    async pluginConnectionDiscover() {
      calls.discover++;
      return { connection, revokedGrants: 0, authorityChanged: false };
    },
    async pluginConnectionDisconnect() {
      return { connection: { ...connection, state: 'disconnected' }, revokedGrants: 1 };
    },
    async pluginAccessList() {
      return [grant];
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
      return grant;
    },
    async pluginAccessRevoke() {
      calls.revoke++;
      return { ...grant, state: 'revoked', revokedAt: '2026-11-04T00:01:00.000Z' };
    },
  } as unknown as LocalRuntimeClient;
  return { client, calls };
}

async function run(argv: readonly string[]) {
  const { client, calls } = fake();
  const output = new PassThrough();
  const error = new PassThrough();
  let stdout = '',
    stderr = '';
  output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  error.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const args = oceanArguments(['plugin', ...argv, '--json']);
  const result = await runPluginCommand(client, args, output, process.stdin, error);
  await new Promise((resolve) => setImmediate(resolve));
  return { result, stdout, stderr, calls };
}

describe('ocean plugin commands', () => {
  it('lists the frozen catalog and inspects one card', async () => {
    const listed = await run(['catalog', 'list']);
    expect(listed.result.code).toBe(0);
    expect(Array.isArray(listed.result.data)).toBe(true);
    const inspected = await run(['catalog', 'inspect', '--plugin', 'github']);
    expect(inspected.result.code).toBe(0);
    expect(inspected.result.data).toMatchObject({ pluginId: 'github', version: '1.0.0' });
  });

  it('installs and enables the pinned version through the runtime', async () => {
    const installed = await run(['catalog', 'install', '--plugin', 'github']);
    expect(installed.result.code).toBe(0);
    expect(installed.calls.install).toBe(1);
    const enabled = await run(['catalog', 'enable', '--plugin', 'github']);
    expect(enabled.result.code).toBe(0);
    expect(enabled.calls.enable).toBe(1);
  });

  it('passes only an environment reference when adding a connection', async () => {
    const added = await run([
      'connections',
      'add',
      '--plugin',
      'github',
      '--name',
      'work',
      '--credential-env',
      'OCEAN_GITHUB_WORK_TOKEN',
      '--account',
      'Work',
    ]);
    expect(added.result.code).toBe(0);
    const request = added.calls.add[0] as Record<string, unknown>;
    expect(request['credentialReference']).toBe('OCEAN_GITHUB_WORK_TOKEN');
    expect(JSON.stringify(request)).not.toMatch(/ghp_|sk-/);
  });

  it('discovers only after the owner consents for the exact generation', async () => {
    const preview = await run(['connections', 'preview', '--connection', 'conn_work']);
    expect(JSON.stringify(preview.result.data)).toContain('https://api.githubcopilot.com/mcp/');
    expect(preview.calls.discover).toBe(0);
    const discovered = await run([
      'connections',
      'discover',
      '--connection',
      'conn_work',
      '--generation',
      '2',
    ]);
    expect(discovered.result.code).toBe(0);
    expect(discovered.calls.discover).toBe(1);
  });

  it('shows the group visibility explanation and refuses an unacknowledged grant', async () => {
    const refused = await run([
      'access',
      'grant',
      '--connection',
      'conn_work',
      '--room',
      'room_1',
      '--bot',
      'bot_dev',
      '--tool',
      'list_issues',
      '--repository',
      'team/api',
      '--plugin',
      'github',
    ]);
    expect(refused.result.code).toBe(4);
    expect(refused.stdout).toContain('Everyone in the group chat');
    expect(refused.stderr).toContain('--acknowledge-group-visibility');
    expect(refused.calls.grant).toHaveLength(0);
  });

  it('grants and revokes when the owner acknowledged the explanation', async () => {
    const granted = await run([
      'access',
      'grant',
      '--connection',
      'conn_work',
      '--room',
      'room_1',
      '--bot',
      'bot_dev',
      '--tool',
      'list_issues',
      '--repository',
      'team/api',
      '--plugin',
      'github',
      '--acknowledge-group-visibility',
    ]);
    expect(granted.result.code).toBe(0);
    expect(granted.stdout).toContain('Everyone in the group chat');
    expect(granted.calls.grant).toHaveLength(1);
    const revoked = await run(['access', 'revoke', '--grant', 'grant_1']);
    expect(revoked.result.code).toBe(0);
    expect(revoked.calls.revoke).toBe(1);
  });
});
