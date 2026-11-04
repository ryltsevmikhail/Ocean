/* eslint-disable no-restricted-imports -- Test-only fixture for the CLI plugin host tests. */
/**
 * Shared harness for the runtime plugin host tests: a private temp profile, a
 * real SQLite store, the composed plugin owner API and a deterministic transport.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach } from 'vitest';
import { openSqliteStore, type SqliteStore } from '@runnets/store-sqlite';
import { ConversationService } from '@runnets/application';
import { canonicalJson } from '@runnets/domain';
import { fakePluginTransport } from '../../../packages/application/test-fixtures/plugin-fakes.js';
import { composePluginRuntime } from '../src/plugin-runtime.js';
import { RuntimePlugins } from '../src/local-runtime/plugins.js';

const directories: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function host(
  options: {
    restored?: boolean;
    env?: Record<string, string | undefined>;
    /** Optional gate that holds discovery open so a drain/stop race stays deterministic. */
    discoverGate?: Promise<void>;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-plugin-host-'));
  directories.push(directory);
  const profile = join(directory, 'profile');
  const store = openSqliteStore({ path: join(directory, 'runtime.sqlite') });
  stores.push(store);
  const tools = [
    { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } },
    { name: 'issue_read', description: 'Read issue', inputSchema: { type: 'object' } },
  ];
  const digest = sha256(canonicalJson([...tools].sort((a, b) => (a.name < b.name ? -1 : 1))));
  const transport = fakePluginTransport(
    async (target) => {
      if (target === undefined) throw Error('plugin_fixture_target');
      await options.discoverGate;
      return {
        target,
        tools,
        schemaDigest: digest,
        account: { identity: 'octocat', verified: true },
        discoveredAt: '2026-11-04T00:00:00.000Z',
        completeness: 'complete',
      };
    },
    () => ({
      kind: 'observed',
      invocationId: 'inv',
      code: 'ok',
      result: { ok: true },
      vendorErrorCode: null,
    }),
  );
  const clock = { now: () => new Date('2026-11-04T00:00:00.000Z') };
  const pluginRuntime = composePluginRuntime({
    profile,
    stores: {
      catalog: store.pluginCatalog,
      connections: store.pluginConnections,
      access: store.pluginAccess,
      admission: store.pluginAdmission,
      operations: store.pluginOperations,
    },
    clock,
    restored: options.restored ?? false,
    env: options.env ?? { OCEAN_PLUGIN_TOKEN: 'fixture-only' },
    transport,
  });
  const plugins = new RuntimePlugins({
    catalog: pluginRuntime.services.catalog,
    connections: pluginRuntime.services.connections,
    access: pluginRuntime.services.access,
    operations: pluginRuntime.operations,
  });
  return { store, plugins, pluginRuntime, clock, transport, profile, directory, tools, digest };
}

export async function dispatch(
  plugins: RuntimePlugins,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const reply = await plugins.dispatch(method, params);
  if ('error' in reply) throw Error(reply.error.code);
  return reply.result;
}

/** Create one group room with two bots through the shared conversation service. */
export function seedRoom(store: SqliteStore): { roomId: string; botId: string } {
  let ids = 0;
  const service = new ConversationService({
    store: store.conversations,
    clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
    nextId: () => 'seed' + String(++ids),
  });
  const bound = service.execute({
    requestId: 'workspace-1',
    workspaceId: 'ws_ocean',
    type: 'BindWorkspace',
    root: '/project',
  });
  if (!bound.ok) throw Error('workspace_seed_failed');
  const dev = service.execute({
    requestId: 'bot-dev',
    workspaceId: 'ws_ocean',
    type: 'CreateBot',
    handle: 'dev',
    name: 'Dev',
    role: 'reviewer',
    provider: 'deepseek',
    model: 'deepseek-flash',
  });
  const review = service.execute({
    requestId: 'bot-review',
    workspaceId: 'ws_ocean',
    type: 'CreateBot',
    handle: 'review',
    name: 'Review',
    role: 'reviewer',
    provider: 'deepseek',
    model: 'deepseek-flash',
  });
  if (!dev.ok || dev.value.kind !== 'bot' || !review.ok || review.value.kind !== 'bot')
    throw Error('bot_seed_failed');
  const room = service.execute({
    requestId: 'room-team',
    workspaceId: 'ws_ocean',
    type: 'CreateGroupRoom',
    title: 'Team',
    botIds: [dev.value.data.id, review.value.data.id],
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('room_seed_failed');
  return { roomId: room.value.data.id, botId: dev.value.data.id };
}

export type HostFixture = ReturnType<typeof host>;
