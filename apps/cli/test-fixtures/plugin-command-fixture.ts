/* eslint-disable no-restricted-imports -- Test-only fixture for the CLI plugin command tests. */
import { PassThrough } from 'node:stream';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { oceanArguments } from '../src/ocean/arguments.js';
import { runPluginCommand } from '../src/ocean/plugin-command.js';

export const view = {
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
export const connection = {
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
  readiness: 'ready',
  tools: ['list_issues'],
  consented: true,
  consentedGeneration: 2,
  consentedAt: '2026-11-04T00:00:00.000Z',
  lastDiscoveryAt: '2026-11-04T00:00:00.000Z',
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};
export const grant = {
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
export const explanation =
  'Everyone in the group chat "Team" (3 participants) including every bot in it will see this answer.';

export function fake() {
  const calls = {
    install: 0,
    repair: 0,
    enable: 0,
    add: [] as unknown[],
    grant: [] as unknown[],
    revoke: 0,
    discover: 0,
    consent: 0,
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
    async pluginRepair() {
      calls.repair++;
      return view;
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
      calls.consent++;
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

export async function run(argv: readonly string[], json = true) {
  const { client, calls } = fake();
  const output = new PassThrough();
  const error = new PassThrough();
  let stdout = '',
    stderr = '';
  output.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  error.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const args = oceanArguments(json ? ['plugin', ...argv, '--json'] : ['plugin', ...argv]);
  const result = await runPluginCommand(client, args, output, process.stdin, error);
  await new Promise((resolve) => setImmediate(resolve));
  return { result, stdout, stderr, calls };
}
