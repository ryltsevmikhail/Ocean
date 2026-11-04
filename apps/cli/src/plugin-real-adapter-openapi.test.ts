/**
 * Task 6 qualification, second transport: the real pinned OpenAPI plugin
 * against a loopback GitHub-like OpenAPI service.
 *
 * The RC2 application pilot is the frozen MCP card, whose declared tool names
 * (`list_issues`/`issue_read`) are MCP wire names; the OpenAPI plugin exposes
 * path-derived names (`repos.listIssues`). This qualification therefore proves
 * the transport-level invariant on the same local GitHub-like data — exactly one
 * business request per allowed call — and is reported separately from the
 * application MCP path instead of being presented as card acceptance.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutorServicePluginTransport } from '@runnets/integrations-executor';
import {
  githubOpenApiAuthTemplates,
  startGithubOpenApiServer,
} from '../test-fixtures/github-openapi-server.js';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openTransport(base: string, name: string) {
  const server = await startGithubOpenApiServer();
  cleanups.push(() => server.close());
  void mkdtempSync(join(tmpdir(), 'ocean-task6-openapi-'));
  const transport = await ExecutorServicePluginTransport.open({
    tenantId: 'task6',
    subjectId: 'task6',
    allowedOrigins: [base === '' ? server.base : base],
    enableExecution: true,
    resolveCredential: () => 'fixture-token',
    provision: (target) => ({
      kind: 'openapi',
      integrationId: target.integrationId,
      name,
      description: 'loopback GitHub-like OpenAPI fixture',
      specJson: server.specJson,
      authTemplates: githubOpenApiAuthTemplates,
      connection: { template: 'bearer', credentialReference: 'OCEAN_GITHUB_WORK_TOKEN' },
    }),
  });
  cleanups.push(() => transport.close());
  return { server, transport };
}

describe('real Executor adapter against a loopback GitHub-like OpenAPI service', () => {
  it('qualifies with exactly one business request per allowed read', async () => {
    const { server, transport } = await openTransport('', 'githubIssues');
    const target = { integrationId: 'github', connectionId: 'pWork', owner: 'user' as const };
    const discovery = await transport.discover(target);
    expect(discovery.completeness).toBe('complete');
    const tool = discovery.tools.find((candidate) => candidate.name === 'repos.listIssues');
    expect(tool).toBeDefined();
    const businessBefore = server.counts.business;
    const first = await transport.invoke(target, {
      invocationId: 'openapi-1',
      tool: 'repos.listIssues',
      arguments: { owner: 'team', repo: 'api' },
    });
    expect(first.kind).toBe('observed');
    expect(server.counts.business - businessBefore).toBe(1);
    const second = await transport.invoke(target, {
      invocationId: 'openapi-2',
      tool: 'repos.listIssues',
      arguments: { owner: 'team', repo: 'api' },
    });
    expect(second.kind).toBe('observed');
    expect(server.counts.business - businessBefore).toBe(2);
  }, 60_000);

  it('never dispatches for an unprovisioned target', async () => {
    const { server, transport } = await openTransport('', 'githubIssues');
    const businessBefore = server.counts.business;
    const outcome = await transport.invoke(
      { integrationId: 'github', connectionId: 'pMissing', owner: 'user' },
      { invocationId: 'openapi-missing', tool: 'repos.listIssues', arguments: {} },
    );
    expect(outcome).toMatchObject({ kind: 'not_started', code: 'connection_unknown' });
    expect(server.counts.business - businessBefore).toBe(0);
  }, 60_000);
});
