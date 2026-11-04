/* eslint-disable no-undef -- Node QA harness, not renderer code. */
// QA-only runtime owner: composes the real shared runtime with a deterministic
// in-process service-plugin transport. No Executor SDK is loaded and execution
// stays disabled; the fake counts discovery/invocation requests so GUI evidence
// can prove the Desktop performed exactly the owner actions it claims.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startLocalRuntime } from '../../cli/dist/local-runtime/host.js';

const profileIndex = process.argv.indexOf('--profile');
const profile = process.argv[profileIndex + 1];
if (!profile) throw new Error('--profile is required');
const log = process.env.OCEAN_QA_PLUGIN_LOG;

const tools = [
  {
    name: 'issue_read',
    description: 'Read one issue and its comments',
    inputSchema: { type: 'object', properties: { owner: {}, repo: {}, issue_number: {} } },
  },
  {
    name: 'list_issues',
    description: 'List issues in one repository',
    inputSchema: { type: 'object', properties: { owner: {}, repo: {} } },
  },
];
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',') +
    '}'
  );
};
const mapped = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
}));
const schemaDigest = createHash('sha256').update(canonical(mapped)).digest('hex');
const counts = { discover: 0, invoke: 0 };
function record(entry) {
  if (log === undefined) return;
  appendFileSync(log, JSON.stringify(entry) + '\n');
}
const transport = {
  qualification: () => ({ qualified: false, reason: 'qa_fixture_only', identities: {} }),
  async discover(target) {
    counts.discover += 1;
    record({ kind: 'discover', target, count: counts.discover });
    return {
      target: target ?? { integrationId: 'github', connectionId: '', owner: 'user' },
      tools,
      schemaDigest,
      account: { identity: 'octocat', verified: true },
      discoveredAt: new Date().toISOString(),
      completeness: 'complete',
    };
  },
  async invoke(target, invocation) {
    counts.invoke += 1;
    record({ kind: 'invoke', target, invocation, count: counts.invoke });
    return {
      kind: 'not_started',
      invocationId: invocation.invocationId,
      code: 'execution_disabled',
      detail: 'QA runtime owner never dispatches plugin calls',
    };
  },
};

const host = await startLocalRuntime({ profile, pluginTransport: transport, provider: null });
record({ kind: 'ready', state: host.status().state, instanceId: host.identity.instanceId });
process.stdout.write(
  JSON.stringify({ state: 'ready', instanceId: host.identity.instanceId }) + '\n',
);
const shutdown = () => {
  void host.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await host.closed;
process.exit(0);
