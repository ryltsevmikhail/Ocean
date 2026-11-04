/* eslint-disable no-restricted-imports -- Crash fixture rig for Task 6 process tests. */
/**
 * Prepared private profile for the Task 6 crash qualification: seeded room,
 * enabled GitHub card, published discovery and an active one-repository grant.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach } from 'vitest';
import { ConversationService } from '@runnets/application';
import { canonicalJson } from '@runnets/domain';
import { openSqliteStore } from '@runnets/store-sqlite';
import { connectLocalRuntime } from '@runnets/tools-node';
import { createRuntime } from '../src/runtime.js';
import { startLocalRuntime } from '../src/local-runtime/host.js';
import { fakePluginTransport } from '../../../packages/application/test-fixtures/plugin-transport-fakes.js';

export const WORKSPACE = 'ws_ocean';
export const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const clock = { now: () => new Date('2026-11-04T00:00:00.000Z') };

export const tools = [
  {
    name: 'list_issues',
    description: 'List issues',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
    },
  },
];
export const digest = sha256(canonicalJson([...tools]));

export async function prepareProfile(): Promise<{
  profile: string;
  room: string;
  room2: string;
  dev: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-task6-crash-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profile');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  closeSync(openSync(join(profile, 'runtime.sqlite'), 'wx', 0o600));
  const store = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
  let counter = 0;
  const service = new ConversationService({
    store: store.conversations,
    clock,
    nextId: () => 'seed' + String(++counter),
  });
  const bond = service.execute({
    requestId: 'workspace-1',
    workspaceId: WORKSPACE,
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
      workspaceId: WORKSPACE,
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
  const room = service.execute({
    requestId: 'room-team',
    workspaceId: WORKSPACE,
    type: 'CreateGroupRoom',
    title: 'Team',
    botIds: ids,
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('room_seed_failed');
  const direct = service.execute({
    requestId: 'room-direct',
    workspaceId: WORKSPACE,
    type: 'OpenDirectRoom',
    botId: ids[0]!,
  });
  if (!direct.ok || direct.value.kind !== 'room') throw Error('room_seed_failed');
  store.close();
  const runtime = createRuntime({ dbPath: join(profile, 'runtime.sqlite'), mode: 'durable' });
  await runtime.ready;
  runtime.close();
  // Prepare an enabled plugin, one connection, a published schema and one grant.
  const host = await startLocalRuntime({
    profile,
    provider: null,
    pluginTransport: fakePluginTransport(
      (target) => ({
        target: target ?? { integrationId: 'github', connectionId: '', owner: 'user' },
        tools,
        schemaDigest: digest,
        account: { identity: 'octocat', verified: true },
        discoveredAt: '2026-11-04T00:00:00.000Z',
        completeness: 'complete',
      }),
      () => ({
        kind: 'not_started',
        invocationId: 'inv',
        code: 'execution_disabled',
        detail: 'preparation only',
      }),
    ),
    pluginEnv: { OCEAN_GITHUB_WORK_TOKEN: 'fixture-token' },
    now: () => Date.parse('2026-11-04T00:00:00.000Z'),
  });
  const client = await connectLocalRuntime({ profile });
  await client.pluginInstall({ pluginId: 'github' });
  await client.pluginEnable({ pluginId: 'github' });
  const connection = await client.pluginConnectionAdd({
    name: 'work',
    pluginId: 'github',
    credentialReference: 'OCEAN_GITHUB_WORK_TOKEN',
  });
  await client.pluginConnectionConsent({
    connectionId: connection.id,
    expectedGeneration: connection.generation,
  });
  await client.pluginConnectionDiscover({
    connectionId: connection.id,
    expectedGeneration: connection.generation,
  });
  for (const roomId of [room.value.data.id, direct.value.data.id]) {
    await client.pluginAccessGrant({
      workspaceId: WORKSPACE,
      roomId,
      botId: ids[0]!,
      pluginId: 'github',
      connectionId: connection.id,
      tools: ['list_issues'],
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
  }
  client.close();
  await host.stop();
  return { profile, room: room.value.data.id, room2: direct.value.data.id, dev: ids[0]! };
}
