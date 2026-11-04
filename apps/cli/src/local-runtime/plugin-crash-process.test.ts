/**
 * Task 6 crash qualification (process suite): a SIGKILL after the durable
 * admission claim and before settlement must leave one visible `uncertain`
 * operation, block every new plugin claim through the journal, and never
 * redispatch — even under a different invocation/request identity. The explicit
 * owner acknowledgement then releases the hold without claiming remote certainty.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectLocalRuntime, type LocalRuntimeClient } from '@runnets/tools-node';
import { startLocalRuntime } from './host.js';
import { fakePluginTransport } from '../../../../packages/application/test-fixtures/plugin-transport-fakes.js';
import { deterministicPluginProvider } from '../../test-fixtures/plugin-chat-provider.js';
import { WORKSPACE, cleanups, prepareProfile } from '../../test-fixtures/plugin-crash-profile.js';

async function waitRun(client: LocalRuntimeClient, room: string, runId: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const snapshot = await client.getRun({ workspaceId: WORKSPACE, roomId: room, runId });
    const status = snapshot?.taskStatus;
    if (status !== undefined && !['queued', 'running', 'preparing'].includes(status))
      return status === 'succeeded' ? 'completed' : status;
    if (Date.now() > deadline) throw Error('unsettled run');
    await sleep(25);
  }
}

it(
  'keeps a post-claim SIGKILL uncertain, holds every new claim and never redispatches',
  { timeout: 120_000 },
  async () => {
    const fixture = await prepareProfile();
    const child = spawn(
      process.execPath,
      [
        resolve('apps/cli/test-fixtures/plugin-crash-owner.ts'),
        fixture.profile,
        'kill-after-claim',
        fixture.room,
        fixture.dev,
      ],
      { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const [code, signal] = (await once(child, 'exit')) as [number | null, string | null];
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' });
    const log = readFileSync(join(fixture.profile, 'crash-log'), 'utf8');
    expect(log).toContain('provider-dispatch 1');
    expect(log).toContain('invoke ');
    expect(log).not.toContain('unexpected-survival');
    expect(output).not.toContain('unexpected');

    // Restart with an independent counting transport: recovery must keep uncertainty
    // and the journal must refuse every fresh plugin claim before dispatch.
    const provider = deterministicPluginProvider({
      tool: 'list_issues',
      arguments: {},
      answer: 'Ответ после разбора.',
    });
    let invokes = 0;
    const countingTransport = fakePluginTransport(
      () => {
        throw Error('recovery never discovers');
      },
      () => {
        invokes += 1;
        return {
          kind: 'observed',
          invocationId: 'inv',
          code: 'ok',
          result: { issues: [] },
          vendorErrorCode: null,
        };
      },
    );
    const host = await startLocalRuntime({
      profile: fixture.profile,
      provider,
      pluginTransport: countingTransport,
      pluginEnv: { OCEAN_GITHUB_WORK_TOKEN: 'fixture-token' },
      now: () => Date.parse('2026-11-04T00:00:00.000Z'),
    });
    cleanups.push(() => host.stop());
    const client = await connectLocalRuntime({ profile: fixture.profile });
    cleanups.push(() => client.close());
    const operations = await client.pluginOperationsList({ roomId: fixture.room });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      state: 'uncertain',
      outcomeCode: 'interrupted',
      tool: 'list_issues',
      repository: 'team/api',
      botId: fixture.dev,
    });
    expect(operations[0]?.detail).toContain('restarted');
    // Startup recovery reopens the verified plugin disabled and revokes its grants
    // (accepted Task 5 policy), so a restart alone cannot spend old permission.
    const connections = await client.pluginConnections();
    expect(connections[0]?.state).toBe('active');
    const plainTurn = await client.submit({
      workspaceId: WORKSPACE,
      roomId: fixture.room2,
      requestId: 'after-crash-turn',
      text: 'повтори',
      to: fixture.dev,
    });
    await waitRun(client, fixture.room2, plainTurn.runId!);
    expect(invokes).toBe(0);
    expect(await client.pluginOperationsList({ roomId: fixture.room })).toHaveLength(1);
    // Re-establish fresh authority explicitly; the journal's unknown effect still holds.
    await client.pluginEnable({ pluginId: 'github' });
    const regrant = await client.pluginAccessGrant({
      workspaceId: WORKSPACE,
      roomId: fixture.room2,
      botId: fixture.dev,
      pluginId: 'github',
      connectionId: connections[0]!.id,
      tools: ['list_issues'],
      repository: 'team/api',
      acknowledgeGroupVisibility: true,
    });
    expect(regrant.state).toBe('active');
    const heldTurn = await client.submit({
      workspaceId: WORKSPACE,
      roomId: fixture.room2,
      requestId: 'held-turn',
      text: 'ещё раз',
      to: fixture.dev,
    });
    await waitRun(client, fixture.room2, heldTurn.runId!);
    expect(invokes).toBe(0);
    const refusalRequest = provider.requests.find((request) =>
      request.messages.some((message) => message.role === 'tool'),
    );
    expect(refusalRequest?.messages.at(-1)?.content).toContain('journal_refused');
    // The explicit owner acknowledgement keeps the record and releases the hold.
    const acknowledged = await client.pluginOperationAcknowledge({
      operationId: operations[0]!.id,
      expectedRevision: operations[0]!.revision,
      reason: 'checked after the crash',
    });
    expect(acknowledged.state).toBe('acknowledged');
    expect(acknowledged.outcomeCode).toBe('interrupted');
    const next = await client.submit({
      workspaceId: WORKSPACE,
      roomId: fixture.room2,
      requestId: 'after-ack-turn',
      text: 'теперь можно',
      to: fixture.dev,
    });
    await waitRun(client, fixture.room2, next.runId!);
    expect(invokes).toBe(1);
    const after = await client.pluginOperationsList({});
    expect(after).toHaveLength(2);
    expect(after.find((operation) => operation.id === operations[0]!.id)?.state).toBe(
      'acknowledged',
    );
    expect(after.filter((operation) => operation.state === 'observed')).toHaveLength(1);
  },
);

it(
  'refuses a second owner while a live runtime owns the profile',
  { timeout: 60_000 },
  async () => {
    const fixture = await prepareProfile();
    const child = spawn(
      process.execPath,
      [resolve('apps/cli/test-fixtures/plugin-crash-owner.ts'), fixture.profile, 'hold-runtime'],
      { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const deadline = Date.now() + 30_000;
    while (!output.includes('ready') && Date.now() < deadline) await sleep(50);
    expect(output).toContain('ready');
    await expect(startLocalRuntime({ profile: fixture.profile, provider: null })).rejects.toThrow(
      /owned by a live|owner_busy|recovery_required/,
    );
    child.kill('SIGTERM');
    await once(child, 'exit');
  },
);
