/**
 * Task 6 denial matrix on the real Executor adapter: every refusal must add zero
 * business requests, an upstream toolset wider than the frozen card is refused
 * before publishing, and a plugin-disabled profile keeps the old behavior.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecutorServicePluginTransport } from '@runnets/integrations-executor';
import { composePluginRuntime } from './plugin-runtime.js';
import { openSqliteStore } from '@runnets/store-sqlite';
import {
  cleanups,
  rig,
  seedConversations,
  seeded,
  TOKEN_REFERENCE,
  clock,
  turnFor,
} from '../test-fixtures/real-adapter-rig.js';
import { startGithubMcpServer } from '../test-fixtures/github-mcp-server.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('real Executor adapter denial and compatibility matrix', () => {
  it('yields zero business requests for every denial path', async () => {
    const r = await rig();
    const grantsBefore = r.queue.services.access.list();
    const before = r.server.counts.toolCalls;
    // Review bot in the same room has no grant.
    expect(await r.tools.forTurn(turnFor(seeded.review), new AbortController().signal)).toBeNull();
    // Dev in another room has no grant.
    expect(
      await r.tools.forTurn(turnFor(seeded.dev, seeded.direct), new AbortController().signal),
    ).toBeNull();
    // A personal connection exists but no grant binds it.
    const personal = r.queue.services.connections.add({
      name: 'personal',
      pluginId: 'github',
      credentialReference: TOKEN_REFERENCE,
    });
    const grant = grantsBefore[0]!;
    const deniedByConnection = await r.admission.call({
      workspaceId: 'ws',
      roomId: seeded.room,
      botId: seeded.dev,
      pluginId: 'github',
      connectionId: personal.id,
      grantId: grant.id,
      tool: 'list_issues',
      arguments: { owner: 'team', repo: 'api' },
      claim: { invocationId: 'deny_conn', taskRunId: 'run_1', attemptId: 'attempt_1' },
    });
    expect(deniedByConnection.admitted).toBe(false);
    // Another repository is outside the grant.
    const otherRepository = await r.admission.call({
      workspaceId: 'ws',
      roomId: seeded.room,
      botId: seeded.dev,
      pluginId: 'github',
      connectionId: grant.connectionId,
      grantId: grant.id,
      tool: 'list_issues',
      arguments: { owner: 'team', repo: 'other' },
      claim: { invocationId: 'deny_repo', taskRunId: 'run_1', attemptId: 'attempt_1' },
    });
    expect(otherRepository.code).toBe('grant_mismatch');
    // An ungranted tool name is refused before claim.
    const ungranted = await r.admission.call({
      workspaceId: 'ws',
      roomId: seeded.room,
      botId: seeded.dev,
      pluginId: 'github',
      connectionId: grant.connectionId,
      grantId: grant.id,
      tool: 'create_issue_comment',
      arguments: { owner: 'team', repo: 'api' },
      claim: { invocationId: 'deny_tool', taskRunId: 'run_1', attemptId: 'attempt_1' },
    });
    expect(ungranted.admitted).toBe(false);
    // Revoked grant cannot be spent by an already resolved tool list.
    const tools = await r.tools.forTurn(r.turn, new AbortController().signal);
    r.queue.services.access.revoke(grant.id);
    const revoked = await tools!.execute(
      { id: 'call_denied', name: 'list_issues', arguments: '{}' },
      new AbortController().signal,
      { taskRunId: 'run_1', attemptId: 'attempt_1' },
    );
    expect(revoked.isError).toBe(true);
    expect(revoked.output).toContain('grant_revoked');
    // A stale connection generation (competing client) is refused.
    const work = r.queue.services.connections.list().find((row) => row.name === 'work')!;
    r.store.pluginConnections.change(
      work.id,
      work.generation,
      { accountLabel: 'other account' },
      '2026-11-04T00:05:00.000Z',
    );
    const stale = await r.admission.call({
      workspaceId: 'ws',
      roomId: seeded.room,
      botId: seeded.dev,
      pluginId: 'github',
      connectionId: work.id,
      grantId: grant.id,
      tool: 'list_issues',
      arguments: { owner: 'team', repo: 'api' },
      claim: { invocationId: 'deny_stale', taskRunId: 'run_1', attemptId: 'attempt_1' },
    });
    expect(stale.admitted).toBe(false);
    expect(r.server.counts.toolCalls - before).toBe(0);
    expect(r.operations.list()).toHaveLength(0);
  });

  it('refuses an upstream toolset wider than the frozen card before publishing a schema', async () => {
    const server = await startGithubMcpServer('extraTool');
    cleanups.push(() => server.close());
    const directory = mkdtempSync(join(tmpdir(), 'ocean-task6-extra-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = openSqliteStore({ path: join(directory, 'runtime.sqlite') });
    cleanups.push(() => store.close());
    seedConversations(store);
    const transport = await ExecutorServicePluginTransport.open({
      tenantId: 'task6',
      subjectId: 'task6',
      allowedOrigins: [server.base],
      enableExecution: true,
      resolveCredential: () => 'fixture-token',
      provision: (target) => ({
        kind: 'mcp',
        integrationId: target.integrationId,
        description: 'loopback fixture',
        endpoint: server.endpoint,
        authTemplates: [
          {
            slug: 'bearer',
            type: 'apiKey',
            headers: { Authorization: ['Bearer ', { type: 'variable', name: 'token' }] },
          },
        ],
        connection: { template: 'bearer', credentialReference: TOKEN_REFERENCE },
      }),
    });
    cleanups.push(() => transport.close());
    const queue = composePluginRuntime({
      profile: join(directory, 'profile'),
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
      env: { [TOKEN_REFERENCE]: 'fixture-token' },
    });
    queue.services.catalog.install({ pluginId: 'github' });
    queue.services.catalog.enable({ pluginId: 'github' });
    const connection = queue.services.connections.add({
      name: 'work',
      pluginId: 'github',
      credentialReference: TOKEN_REFERENCE,
    });
    queue.services.connections.consent({
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    await expect(
      queue.services.connections.discover({
        connectionId: connection.id,
        expectedGeneration: connection.generation,
      }),
    ).rejects.toThrow(/unexpected_tool/);
    expect(queue.services.connections.list()[0]?.schemaDigest).toBeNull();
  });

  it('proves the plugin-disabled default still behaves exactly as before', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ocean-task6-disabled-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = openSqliteStore({ path: join(directory, 'runtime.sqlite') });
    cleanups.push(() => store.close());
    const queue = composePluginRuntime({
      profile: join(directory, 'profile'),
      stores: {
        catalog: store.pluginCatalog,
        connections: store.pluginConnections,
        access: store.pluginAccess,
        admission: store.pluginAdmission,
        operations: store.pluginOperations,
      },
      clock,
      restored: false,
      env: {},
    });
    expect(queue.qualified).toBe(false);
    await expect(queue.tools?.forTurn(turnFor(), new AbortController().signal)).resolves.toBeNull();
    expect(queue.transport.qualification().reason).toBe('execution_disabled');
    expect(sha256(queue.adapter.sdkVersion)).toHaveLength(64);
    expect(queue.services.catalog.install({ pluginId: 'github' }).enabled).toBe(false);
  });
});
