/**
 * Freshness / completeness contract for `discover()`.
 *
 * A discovery must never return a stale persisted snapshot or an incomplete
 * upstream listing as a successful catalog: it performs one bounded upstream
 * re-discovery, refuses with `catalog_incomplete` on the SDK's
 * `tool_sync_failed` signal, and only then is a returned catalog authoritative
 * (including a genuine empty one).
 */
import { describe, expect, it } from 'vitest';

import { mcpPlugin } from '@executor-js/plugin-mcp/core';

import { runDiscovery } from './discovery.js';
import type { ExecutorHost, HostConnection, HostTool } from './host-types.js';
import { HostOperationError } from './host-types.js';
import { createTestTransport } from './test-support.js';
import { closeServer } from '../test-fixtures/loopback.js';
import { mcpAuthTemplates, startMcpServer } from '../test-fixtures/mcp-server.js';
import { memoryProvider } from '../test-fixtures/synthetic-plugin.js';
import { createExecutorHost } from './sdk-boundary.js';

const healthyConnection = (): HostConnection => ({
  identityLabel: null,
  lastHealth: { status: 'healthy', identity: null, detail: null, reason: null },
});

const syncFailedConnection = (): HostConnection => ({
  identityLabel: null,
  lastHealth: {
    status: 'degraded',
    identity: null,
    detail: 'Tool sync failing: MCP discovery timed out after 15000ms',
    reason: 'tool_sync_failed',
  },
});

interface StubOptions {
  readonly connection: HostConnection | null;
  readonly tools?: readonly HostTool[];
  readonly refreshError?: HostOperationError;
  readonly order?: string[];
}

function stubHost(options: StubOptions): ExecutorHost {
  const host = {
    async getConnection() {
      options.order?.push('getConnection');
      return options.connection;
    },
    async refreshConnection() {
      options.order?.push('refreshConnection');
      if (options.refreshError !== undefined) throw options.refreshError;
    },
    async listTools() {
      options.order?.push('listTools');
      return options.tools ?? [];
    },
  };
  return host as unknown as ExecutorHost;
}

const target = { integrationId: 'probe', connectionId: 'work', owner: 'user' as const };

describe('discovery contract: fresh and complete only', () => {
  it('refreshes the upstream catalog before reading it', async () => {
    const order: string[] = [];
    const host = stubHost({ connection: healthyConnection(), order });
    const catalog = await runDiscovery(host, target, {});
    expect(order.slice(0, 3)).toEqual(['getConnection', 'refreshConnection', 'getConnection']);
    expect(catalog.completeness).toBe('complete');
  });

  it('an incomplete upstream listing is refused, never returned as an empty catalog', async () => {
    const host = stubHost({ connection: syncFailedConnection() });
    await expect(runDiscovery(host, target, {})).rejects.toMatchObject({
      name: 'ServicePluginDiscoveryRefusedError',
      code: 'catalog_incomplete',
    });
  });

  it('a failed re-discovery refuses instead of falling back to a stale snapshot', async () => {
    const host = stubHost({
      connection: healthyConnection(),
      tools: [
        {
          address: 'tools.probe.user.work.stale',
          name: 'stale',
          description: '',
          inputSchema: null,
        },
      ],
      refreshError: new HostOperationError('failure', 'storage', 'refresh failed'),
    });
    await expect(runDiscovery(host, target, {})).rejects.toMatchObject({
      code: 'transport_failure',
    });
  });

  it('a complete upstream listing with zero tools is an authoritative empty catalog', async () => {
    const host = stubHost({ connection: healthyConnection(), tools: [] });
    const catalog = await runDiscovery(host, target, {});
    expect(catalog.tools).toEqual([]);
    expect(catalog.completeness).toBe('complete');
    expect(catalog.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the transport surfaces the incomplete refusal through the port', async () => {
    const host = stubHost({ connection: syncFailedConnection() });
    const transport = await createTestTransport(host, { enableExecution: true });
    await expect(transport.discover(target)).rejects.toMatchObject({ code: 'catalog_incomplete' });
  });

  it('real MCP: discovery performs a fresh tools/list and reports completeness', async () => {
    const mcp = await startMcpServer('ok');
    const provider = memoryProvider();
    const host = await createExecutorHost({
      tenantId: 'probe-tenant',
      subjectId: 'probe-subject',
      allowedOrigins: [mcp.base],
      plugins: [mcpPlugin()],
      providers: [provider.provider],
    });
    const integrationId = await host.installMcp({
      name: 'Probe MCP',
      description: 'Synthetic',
      endpoint: `${mcp.base}/mcp`,
      remoteTransport: 'streamable-http',
      authTemplates: mcpAuthTemplates,
    });
    await host.createConnection({
      integrationId,
      connectionId: 'work',
      owner: 'user',
      template: 'bearer',
      value: 'static-secret-1',
    });
    const discoveryTarget = { integrationId, connectionId: 'work', owner: 'user' as const };
    const before = mcp.counts.byMethod['tools/list'] ?? 0;
    const transport = await createTestTransport(host, { enableExecution: true });
    const catalog = await transport.discover(discoveryTarget);
    expect(catalog.completeness).toBe('complete');
    expect(catalog.tools.length).toBeGreaterThan(0);
    expect(mcp.counts.byMethod['tools/list'] ?? 0).toBeGreaterThan(before);
    await transport.close();
    await mcp.close();
  });

  it('real MCP: an oversized listing fails closed instead of returning 0 tools', async () => {
    const mcp = await startMcpServer('hugeListing');
    const provider = memoryProvider();
    const host = await createExecutorHost({
      tenantId: 'probe-tenant',
      subjectId: 'probe-subject',
      allowedOrigins: [mcp.base],
      plugins: [mcpPlugin()],
      providers: [provider.provider],
    });
    const integrationId = await host.installMcp({
      name: 'Huge MCP',
      description: 'Synthetic',
      endpoint: `${mcp.base}/mcp`,
      remoteTransport: 'streamable-http',
      authTemplates: mcpAuthTemplates,
    });
    await host.createConnection({
      integrationId,
      connectionId: 'work',
      owner: 'user',
      template: 'bearer',
      value: 'static-secret-1',
    });
    const transport = await createTestTransport(host, { enableExecution: true });
    const discoveryTarget = { integrationId, connectionId: 'work', owner: 'user' as const };
    // The SDK's own MCP catalog sync times out at its fixed 15 s bound; a short
    // discovery deadline turns that into a fast, explicit refusal.
    const outcome = await transport.discover(discoveryTarget, { deadlineMs: 2_000 }).then(
      (catalog) => ({ kind: 'success' as const, catalog }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect((outcome.error as { code?: string }).code).toBeDefined();
      expect(['deadline_exceeded', 'transport_failure', 'catalog_incomplete']).toContain(
        (outcome.error as { code?: string }).code,
      );
    }
    await transport.close();
    await Promise.all([closeServer(mcp.server)]);
  }, 30_000);
});
