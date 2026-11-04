/**
 * Real `@executor-js/plugin-mcp@1.6.11` transport counters over a loopback
 * streamable-HTTP MCP server.
 *
 * Discovery (session handshake + `tools/list`) is counted separately from the
 * business dispatch: exactly one `tools/call` JSON-RPC request per allowed
 * invocation, including a dropped response and a transport-level 401.
 */
import { describe, expect, it } from 'vitest';

import { mcpPlugin } from '@executor-js/plugin-mcp/core';

import { createExecutorHost } from './sdk-boundary.js';
import type { ExecutorHost } from './host-types.js';
import { ExecutorServicePluginTransport } from './transport.js';
import { mcpAuthTemplates, startMcpServer } from '../test-fixtures/mcp-server.js';
import type { McpScenario } from '../test-fixtures/mcp-server.js';
import { memoryProvider } from '../test-fixtures/synthetic-plugin.js';

interface Harness {
  readonly mcp: Awaited<ReturnType<typeof startMcpServer>>;
  readonly host: ExecutorHost;
  readonly transport: ExecutorServicePluginTransport;
  readonly target: { integrationId: string; connectionId: string; owner: 'user' };
  resetToolCalls(): void;
  close(): Promise<void>;
}

async function openHarness(scenario: McpScenario): Promise<Harness> {
  const mcp = await startMcpServer(scenario);
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
    description: 'Synthetic MCP server',
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

  const target = { integrationId, connectionId: 'work', owner: 'user' as const };
  const transport = await ExecutorServicePluginTransport.fromHost(host, { enableExecution: true });
  return {
    mcp,
    host,
    transport,
    target,
    resetToolCalls() {
      mcp.counts.toolCalls = 0;
    },
    async close() {
      await transport.close();
      await mcp.close();
    },
  };
}

const toolCallDelta = (counts: { byMethod: Record<string, number> }): number =>
  counts.byMethod['tools/call'] ?? 0;

describe('real MCP plugin dispatch counters', () => {
  it('success: exactly one tools/call dispatch', async () => {
    const harness = await openHarness('ok');
    const catalog = await harness.transport.discover(harness.target);
    const tool = catalog.tools.find((candidate) => candidate.name === 'write_thing');
    expect(tool).toBeDefined();
    const before = toolCallDelta(harness.mcp.counts);
    harness.resetToolCalls();
    const outcome = await harness.transport.invoke(harness.target, {
      invocationId: 'mcp-ok',
      tool: 'write_thing',
      arguments: { value: 'x' },
    });
    expect(harness.mcp.counts.toolCalls).toBe(1);
    expect(toolCallDelta(harness.mcp.counts)).toBe(before + 1);
    expect(outcome).toMatchObject({ kind: 'observed', code: 'ok' });
    await harness.close();
  });

  it('tool-reported error result: one dispatch, observed vendor error (no replay)', async () => {
    const harness = await openHarness('toolError');
    const before = toolCallDelta(harness.mcp.counts);
    const outcome = await harness.transport.invoke(harness.target, {
      invocationId: 'mcp-tool-error',
      tool: 'write_thing',
      arguments: { value: 'x' },
    });
    expect(toolCallDelta(harness.mcp.counts)).toBe(before + 1);
    expect(outcome).toMatchObject({ kind: 'observed', vendorErrorCode: 'mcp_tool_error' });
    await harness.close();
  });

  it('transport-level 401: one tools/call attempt, observed auth rejection', async () => {
    const harness = await openHarness('transport401');
    const before = toolCallDelta(harness.mcp.counts);
    const outcome = await harness.transport.invoke(harness.target, {
      invocationId: 'mcp-transport401',
      tool: 'write_thing',
      arguments: { value: 'x' },
    });
    expect(toolCallDelta(harness.mcp.counts)).toBe(before + 1);
    expect(outcome).toMatchObject({ kind: 'observed', vendorErrorCode: 'connection_rejected' });
    await harness.close();
  });

  it('dropped response after a server-side write: one tools/call, uncertain, no retry', async () => {
    const harness = await openHarness('drop');
    const before = toolCallDelta(harness.mcp.counts);
    const outcome = await harness.transport.invoke(harness.target, {
      invocationId: 'mcp-drop',
      tool: 'write_thing',
      arguments: { value: 'x' },
    });
    expect(toolCallDelta(harness.mcp.counts)).toBe(before + 1);
    expect(outcome).toMatchObject({ kind: 'uncertain', code: 'transport_failure' });
    await harness.close();
  });

  it('more than 256 tools: discovery fails closed, no catalog is returned', async () => {
    const harness = await openHarness('manyTools');
    await expect(harness.transport.discover(harness.target)).rejects.toMatchObject({
      name: 'ServicePluginDiscoveryRefusedError',
      code: 'too_many_tools',
    });
    await harness.close();
  });
});
