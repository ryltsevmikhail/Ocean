/**
 * Task 6 host integration: granted plugin tools inside the real authenticated
 * runtime for normal chat turns and broadcast children.
 *
 * A deterministic provider requests one plugin tool; the runtime resolves only
 * the addressed bot's grants, journals the call through SQLite and publishes the
 * answer. Broadcast children each resolve their own bot's grants, so a child
 * without a grant receives a plain text turn with no tool definitions at all.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '@runnets/domain';
import { ConversationService } from '@runnets/application';
import { connectLocalRuntime, type LocalRuntimeClient } from '@runnets/tools-node';
import { openSqliteStore, type SqliteStore } from '@runnets/store-sqlite';
import { createRuntime } from '../runtime.js';
import { startLocalRuntime, type LocalRuntimeHost } from './host.js';
import { fakePluginTransport } from '../../../../packages/application/test-fixtures/plugin-transport-fakes.js';
import { deterministicPluginProvider } from '../../test-fixtures/plugin-chat-provider.js';

const WORKSPACE = 'ws_ocean';
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const clock = { now: () => new Date('2026-11-04T00:00:00.000Z') };

interface SeededProfile {
  readonly profile: string;
  readonly room: string;
  readonly dev: string;
  readonly review: string;
}

async function seedProfile(): Promise<SeededProfile> {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-task6-chat-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const profile = join(directory, 'profile');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  closeSync(openSync(join(profile, 'runtime.sqlite'), 'wx', 0o600));
  const store: SqliteStore = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
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
  store.close();
  const runtime = createRuntime({ dbPath: join(profile, 'runtime.sqlite'), mode: 'durable' });
  await runtime.ready;
  runtime.close();
  return { profile, room: room.value.data.id, dev: ids[0]!, review: ids[1]! };
}

function transportFixture() {
  const tools = ['issue_read', 'list_issues'].map((name) => ({
    name,
    description: name,
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
    },
  }));
  const digest = sha256(canonicalJson([...tools]));
  return fakePluginTransport(
    (target) => ({
      target: target ?? { integrationId: 'github', connectionId: '', owner: 'user' },
      tools,
      schemaDigest: digest,
      account: { identity: 'octocat', verified: true },
      discoveredAt: '2026-11-04T00:00:00.000Z',
      completeness: 'complete',
    }),
    () => ({
      kind: 'observed',
      invocationId: 'inv',
      code: 'ok',
      result: { issues: [{ number: 7, title: 'Composer loses focus' }] },
      vendorErrorCode: null,
    }),
  );
}

async function waitRun(client: LocalRuntimeClient, room: string, runId: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const snapshot = await client.getRun({ workspaceId: WORKSPACE, roomId: room, runId });
    const status = snapshot?.taskStatus;
    if (status !== undefined && !['queued', 'running', 'preparing'].includes(status))
      return status === 'succeeded' ? 'completed' : status;
    if (Date.now() > deadline) throw Error('unsettled run');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startFixture(input: { readonly withGrants: boolean; readonly answer?: string }) {
  const seeded = await seedProfile();
  const provider = deterministicPluginProvider({
    tool: 'list_issues',
    arguments: {},
    answer: input.answer ?? 'Я прочитал issues из team/api.',
  });
  const transport = transportFixture();
  const host: LocalRuntimeHost = await startLocalRuntime({
    profile: seeded.profile,
    provider,
    pluginTransport: transport,
    pluginEnv: { OCEAN_GITHUB_WORK_TOKEN: 'fixture-token' },
    now: () => Date.parse('2026-11-04T00:00:00.000Z'),
  });
  cleanups.push(() => host.stop());
  const client = await connectLocalRuntime({ profile: seeded.profile });
  cleanups.push(() => client.close());
  if (input.withGrants) {
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
    await client.pluginAccessGrant({
      workspaceId: WORKSPACE,
      roomId: seeded.room,
      botId: seeded.dev,
      pluginId: 'github',
      connectionId: connection.id,
      tools: ['list_issues'],
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
  }
  return { ...seeded, provider, transport, host, client };
}

describe('granted plugin tools through actual chat', () => {
  it('reads issues in a normal chat turn and journals exactly one operation', async () => {
    const fixture = await startFixture({ withGrants: true });
    const receipt = await fixture.client.submit({
      workspaceId: WORKSPACE,
      roomId: fixture.room,
      requestId: 'normal-turn-1',
      text: 'Посмотри открытые issues',
      to: fixture.dev,
    });
    expect(receipt.runId).not.toBeNull();
    expect(await waitRun(fixture.client, fixture.room, receipt.runId!)).toBe('completed');
    const history = await fixture.client.history({
      workspaceId: WORKSPACE,
      roomId: fixture.room,
      after: 0,
      limit: 20,
    });
    expect(history.some((message) => message.body.includes('Я прочитал issues'))).toBe(true);
    // The tool ran: the provider saw the granted tool, then its result.
    expect(fixture.provider.requests[0]?.tools).toEqual(['list_issues']);
    expect(fixture.provider.requests[1]?.messages.at(-1)?.content).toContain(
      'Composer loses focus',
    );
    expect(fixture.provider.requests[1]?.tools).toEqual(['list_issues']);
    expect(fixture.transport.invokeCalls).toBe(1);
    const operations = await fixture.client.pluginOperationsList({ roomId: fixture.room });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      tool: 'list_issues',
      state: 'observed',
      repository: 'team/api',
      botId: fixture.dev,
    });
    // Reading the operation back over the authenticated socket is bounded metadata.
    const shown = await fixture.client.pluginOperationShow({ operationId: operations[0]!.id });
    expect(shown.argumentsDigest).toMatch(/^[a-f0-9]{64}$/);
  }, 60_000);

  it('gives each broadcast child only its own grants and leaks nothing to the other', async () => {
    const fixture = await startFixture({ withGrants: true });
    const batch = await fixture.client.broadcastSubmit({
      workspaceId: WORKSPACE,
      roomId: fixture.room,
      requestId: 'broadcast-1',
      text: 'Что в issues?',
    });
    const deadline = Date.now() + 20_000;
    let view = await fixture.client.broadcastGet({
      workspaceId: WORKSPACE,
      roomId: fixture.room,
      batchId: batch.id,
    });
    while (view.state === 'open' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      view = await fixture.client.broadcastGet({
        workspaceId: WORKSPACE,
        roomId: fixture.room,
        batchId: batch.id,
      });
    }
    expect(view.state).toBe('completed');
    // Exactly one plugin invocation happened: only the granted dev bot.
    const operations = await fixture.client.pluginOperationsList({ roomId: fixture.room });
    expect(operations.filter((operation) => operation.state === 'observed')).toHaveLength(1);
    expect(operations[0]?.botId).toBe(fixture.dev);
    expect(fixture.transport.invokeCalls).toBe(1);
    // Frozen order: dev child (tool call + final round) then review child (plain text,
    // no tool definition at all — the grant never leaks to the sibling).
    expect(fixture.provider.requests.map((request) => request.tools.length)).toEqual([1, 1, 0]);
    // The review child's answer is published too, without any plugin operation.
    const history = await fixture.client.history({
      workspaceId: WORKSPACE,
      roomId: fixture.room,
      after: 0,
      limit: 20,
    });
    expect(history.filter((message) => message.author === 'bot')).toHaveLength(2);
  }, 60_000);

  it('behaves exactly like the plugin-disabled profile when no grant exists', async () => {
    const fixture = await startFixture({ withGrants: false });
    const receipt = await fixture.client.submit({
      workspaceId: WORKSPACE,
      roomId: fixture.room,
      requestId: 'normal-turn-2',
      text: 'Обычный вопрос',
      to: fixture.dev,
    });
    expect(await waitRun(fixture.client, fixture.room, receipt.runId!)).toBe('completed');
    expect(fixture.provider.requests[0]?.tools).toEqual([]);
    expect(fixture.transport.invokeCalls).toBe(0);
    expect(fixture.transport.discoverCalls).toBe(0);
    expect(await fixture.client.pluginOperationsList({ roomId: fixture.room })).toHaveLength(0);
  }, 60_000);
});
