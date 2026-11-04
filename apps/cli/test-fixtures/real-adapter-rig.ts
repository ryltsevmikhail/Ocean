/* eslint-disable no-restricted-imports -- Loopback fixture rig for Task 6 tests. */
/**
 * Shared rig for the Task 6 real-adapter tests: SQLite stores + application
 * services + the real qualified Executor transport against a loopback
 * GitHub-like MCP server. Every test owns its own fixture and cleanup.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import {
  ExecutorServicePluginTransport,
  type ExecutorProvision,
} from '@runnets/integrations-executor';
import type {
  PluginCallAdmissionService,
  PluginOperationsService,
  PluginToolService,
  ServicePluginTransportPort,
} from '@runnets/application';
import { ConversationService } from '@runnets/application';
import type { ChatTurn } from '@runnets/domain';
import { openSqliteStore, type SqliteStore } from '@runnets/store-sqlite';
import { composePluginRuntime } from '../src/plugin-runtime.js';
import { startGithubMcpServer, type GithubMcpServer } from './github-mcp-server.js';

export const clock = { now: () => new Date('2026-11-04T00:00:00.000Z') };
export const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export const TOKEN_REFERENCE = 'OCEAN_GITHUB_WORK_TOKEN';

export interface Rig {
  readonly server: GithubMcpServer;
  readonly store: SqliteStore;
  readonly queue: ReturnType<typeof composePluginRuntime>;
  readonly admission: PluginCallAdmissionService;
  readonly tools: PluginToolService;
  readonly operations: PluginOperationsService;
  readonly turn: ChatTurn;
  readonly invokeOptions: number[];
}

export const bot = (id: string) => ({
  id,
  workspaceId: 'ws',
  handle: id,
  name: id,
  role: 'reviewer',
  provider: 'deepseek',
  model: 'deepseek-flash',
  profileVersion: 1,
});
export const seeded = { dev: 'bot_dev', review: 'bot_review', room: 'room', direct: 'room2' };
export const turnFor = (botId = seeded.dev, roomId = seeded.room): ChatTurn => ({
  id: 'turn_1',
  workspaceId: 'ws',
  roomId,
  requestId: 'req_1',
  taskRunId: 'run_1',
  inboundMessageId: 'm1',
  readThroughSeq: 1,
  bot: bot(botId),
  status: 'accepted',
  text: '',
  preparedVersion: null,
  stopReason: 'end_turn',
});

export async function rig(
  options: {
    scenario?: 'ok' | 'dropToolReply' | 'extraTool';
    connectionName?: string;
    token?: string;
  } = {},
): Promise<Rig> {
  const server = await startGithubMcpServer(options.scenario ?? 'ok');
  cleanups.push(() => server.close());
  const directory = mkdtempSync(join(tmpdir(), 'ocean-task6-mcp-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profile');
  const store = openSqliteStore({ path: join(directory, 'runtime.sqlite') });
  cleanups.push(() => store.close());
  seedConversations(store);
  const env: Record<string, string> = { [TOKEN_REFERENCE]: options.token ?? 'fixture-token' };
  const invokeOptions: number[] = [];
  const inner = await ExecutorServicePluginTransport.open({
    tenantId: 'task6',
    subjectId: 'task6',
    allowedOrigins: [server.base],
    enableExecution: true,
    resolveCredential: (reference) => env[reference] ?? null,
    provision: (target): ExecutorProvision | null => {
      const row = store.pluginConnections.get(target.connectionId);
      if (row === null || row.pluginId !== target.integrationId) return null;
      return {
        kind: 'mcp',
        versionNegotiation: 'legacy',
        integrationId: target.integrationId,
        description: 'GitHub issues (read-only loopback fixture)',
        endpoint: server.endpoint,
        authTemplates: [
          {
            slug: 'bearer',
            type: 'apiKey',
            headers: { Authorization: ['Bearer ', { type: 'variable', name: 'token' }] },
          },
        ],
        connection: { template: 'bearer', credentialReference: row.credentialReference },
      };
    },
  });
  cleanups.push(() => inner.close());
  const transport: ServicePluginTransportPort = {
    ...(inner.sessions === undefined ? {} : { sessions: inner.sessions }),
    qualification: () => inner.qualification(),
    discover: (target, discoverOptions) => inner.discover(target, discoverOptions),
    invoke: (target, invocation, invokeOpts) => {
      invokeOptions.push(invokeOpts?.deadlineMs ?? 0);
      return inner.invoke(target, invocation, invokeOpts);
    },
  };
  const queue = composePluginRuntime({
    profile,
    stores: {
      catalog: store.pluginCatalog,
      connections: store.pluginConnections,
      access: store.pluginAccess,
      admission: store.pluginAdmission,
      operations: store.pluginOperations,
    },
    clock,
    restored: false,
    transport,
    env,
  });
  queue.services.catalog.install({ pluginId: 'github' });
  queue.services.catalog.enable({ pluginId: 'github' });
  const connection = queue.services.connections.add({
    name: options.connectionName ?? 'work',
    pluginId: 'github',
    credentialReference: TOKEN_REFERENCE,
  });
  queue.services.connections.consent({
    connectionId: connection.id,
    expectedGeneration: connection.generation,
  });
  const discovered = await queue.services.connections.discover({
    connectionId: connection.id,
    expectedGeneration: connection.generation,
  });
  expect(discovered.connection.tools).toEqual(['issue_read', 'list_issues']);
  queue.services.access.grant({
    workspaceId: 'ws',
    roomId: seeded.room,
    botId: seeded.dev,
    pluginId: 'github',
    connectionId: connection.id,
    tools: ['list_issues', 'issue_read'],
    repository: 'team/api',
    acknowledgeGroupVisibility: true,
  });
  if (queue.admission === null || queue.tools === null || queue.operations === null)
    throw Error('plugin services not composed');
  return {
    server,
    store,
    queue,
    admission: queue.admission,
    tools: queue.tools,
    operations: queue.operations,
    turn: turnFor(),
    invokeOptions,
  };
}

/** Seed the durable conversation state through the shared service, as the CLI does. */
export function seedConversations(store: SqliteStore): void {
  let counter = 0;
  const service = new ConversationService({
    store: store.conversations,
    clock,
    nextId: () => 'seed' + String(++counter),
  });
  const bond = service.execute({
    requestId: 'workspace-1',
    workspaceId: 'ws',
    type: 'BindWorkspace',
    root: '/project',
  });
  if (!bond.ok) throw Error('workspace_seed_failed');
  const ids: string[] = [];
  for (const [requestId, handle] of [
    ['bot-dev', 'dev'],
    ['bot-review', 'review'],
  ] as const) {
    const created = service.execute({
      requestId,
      workspaceId: 'ws',
      type: 'CreateBot',
      handle,
      name: handle,
      role: 'reviewer',
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
    if (!created.ok || created.value.kind !== 'bot') throw Error('bot_seed_failed');
    ids.push(created.value.data.id);
  }
  const group = service.execute({
    requestId: 'room-team',
    workspaceId: 'ws',
    type: 'CreateGroupRoom',
    title: 'Team',
    botIds: ids,
  });
  if (!group.ok || group.value.kind !== 'room') throw Error('room_seed_failed');
  seeded.room = group.value.data.id;
  const direct = service.execute({
    requestId: 'room-direct',
    workspaceId: 'ws',
    type: 'OpenDirectRoom',
    botId: ids[0]!,
  });
  if (!direct.ok || direct.value.kind !== 'room') throw Error('room_seed_failed');
  seeded.direct = direct.value.data.id;
  seeded.dev = ids[0]!;
  seeded.review = ids[1]!;
}

export const execute = async (
  r: Rig,
  name: string,
  args: Record<string, unknown>,
  identity = 'call_1',
) => {
  const tools = await r.tools.forTurn(r.turn, new AbortController().signal);
  if (tools === null) throw Error('no granted tools');
  return tools.execute(
    { id: identity, name, arguments: JSON.stringify(args) },
    new AbortController().signal,
    { taskRunId: 'run_1', attemptId: 'attempt_1' },
  );
};
