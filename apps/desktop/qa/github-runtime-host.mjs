/* eslint-disable no-undef -- Node QA harness, not renderer code. */
// QA-only runtime owner for the Task 6 client demonstrations: the real qualified
// Executor transport against a loopback GitHub-like MCP server, plus a
// deterministic provider that asks for one `issue_read`. Counters are appended
// to the private fixture log so CLI/TUI/Desktop evidence is attributable.
import { appendFileSync } from 'node:fs';
import { startLocalRuntime } from '../../cli/dist/local-runtime/host.js';
import { deterministicProvider, startGithubMcpServer } from './github-fixture.mjs';

const profileIndex = process.argv.indexOf('--profile');
const profile = process.argv[profileIndex + 1];
if (!profile) throw new Error('--profile is required');
const log = process.env.OCEAN_QA_PLUGIN_LOG;
const endpointOverride = process.env.OCEAN_QA_PLUGIN_ENDPOINT;

const record = (entry) => {
  if (log === undefined) return;
  appendFileSync(log, JSON.stringify(entry) + '\n');
};

const mcp = await startGithubMcpServer();
record({ kind: 'mcp-ready', endpoint: mcp.endpoint, counts: mcp.counts });
const provider = deterministicProvider();
const host = await startLocalRuntime({
  profile,
  provider,
  pluginEndpointOverride: endpointOverride ?? mcp.endpoint,
  pluginEnv: process.env,
});
record({ kind: 'ready', instanceId: host.identity.instanceId, mcpCounts: mcp.counts });
process.stdout.write(
  JSON.stringify({ state: 'ready', instanceId: host.identity.instanceId, endpoint: mcp.endpoint }) +
    '\n',
);
const shutdown = () => {
  record({ kind: 'final', mcpCounts: mcp.counts, requests: provider.requestCount() });
  void host
    .stop()
    .finally(() => mcp.close())
    .finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await host.closed;
record({ kind: 'final', mcpCounts: mcp.counts, requests: provider.requestCount() });
process.exit(0);
