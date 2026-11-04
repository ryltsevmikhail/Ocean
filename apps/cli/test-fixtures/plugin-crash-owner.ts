// Synthetic plugin owner for the SIGKILL/restart qualification; launched with an isolated environment.
import { appendFileSync } from 'node:fs';
import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { connectLocalRuntime } from '@runnets/tools-node';

const profile = process.argv[2]!;
const scenario = process.argv[3] ?? 'kill-after-claim';
const log = profile + '/crash-log';

function record(line: string): void {
  appendFileSync(log, line + '\n', { flush: true });
}

let dispatched = 0;
const provider = {
  id: 'deepseek',
  models: ['deepseek-flash'],
  capabilities: { streaming: true, usage: true, reasoning: false, toolCalls: true },
  async *stream(request) {
    const last = request.messages[request.messages.length - 1];
    if (last?.role === 'tool') {
      yield { type: 'text_delta', text: 'answer after tool' };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
      return;
    }
    dispatched += 1;
    record('provider-dispatch ' + String(dispatched));
    yield {
      type: 'tool_call',
      call: { id: 'crash_call', name: 'list_issues', arguments: '{}' },
    };
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
    yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
  },
};

const transport = {
  qualification: () => ({
    qualified: true,
    reason: null,
    identities: { '@executor-js/sdk': '1.6.11' },
  }),
  discover: async () => {
    throw Error('crash owner never discovers');
  },
  invoke: async (target: unknown, invocation: { invocationId: string }) => {
    record('invoke ' + JSON.stringify({ target, invocationId: invocation.invocationId }));
    // The durable claim and the operation row are committed at this point; a hard
    // kill models a process loss after dispatch and before settlement.
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
    return {
      kind: 'uncertain',
      invocationId: invocation.invocationId,
      code: 'internal_failure',
      detail: 'unreachable',
    };
  },
};

const host = await startLocalRuntime({
  profile,
  provider,
  pluginTransport: transport,
  pluginEnv: { OCEAN_GITHUB_WORK_TOKEN: 'fixture-token' },
  now: () => Date.parse('2026-11-04T00:00:00.000Z'),
});
record('ready ' + host.identity.instanceId);
if (scenario === 'hold-runtime') {
  // A live owner exists: another runtime on the same profile must refuse recovery.
  process.stdout.write(JSON.stringify({ state: 'ready' }) + '\n');
  const stop = () => void host.stop().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await host.closed;
  process.exit(0);
}
const client = await connectLocalRuntime({ profile });
// Startup recovery reopens the plugin disabled and revokes old grants; the owner
// explicitly re-enables the verified version and re-grants before dispatching.
await client.pluginEnable({ pluginId: 'github' });
const connections = await client.pluginConnections();
await client.pluginAccessGrant({
  workspaceId: 'ws_ocean',
  roomId: process.argv[4]!,
  botId: process.argv[5]!,
  pluginId: 'github',
  connectionId: connections[0]!.id,
  tools: ['list_issues'],
  repository: 'team/api',
  acknowledgeGroupVisibility: true,
});
const receipt = await client.submit({
  workspaceId: 'ws_ocean',
  roomId: process.argv[4]!,
  requestId: 'crash-turn',
  text: 'читай issues',
  to: process.argv[5]!,
});
record('admitted ' + JSON.stringify(receipt));
// Wait for the SIGKILL performed by the transport invocation.
await new Promise((resolve) => setTimeout(resolve, 10_000));
record('unexpected-survival');
client.close();
void host.stop();
setTimeout(() => process.exit(0), 200);
