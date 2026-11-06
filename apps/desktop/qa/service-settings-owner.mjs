// Disposable current-source owner: real runtime persistence and MCP, deterministic provider.
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalRuntime } from '../../cli/dist/local-runtime/host.js';
import { openOceanProfile } from '../../cli/dist/ocean/profile.js';
import { httpFixture } from '../../../packages/integrations-mcp/dist/prototype-http-fixture.js';
const [root, profile, workspace] = process.argv.slice(2);
const record = (value) =>
  appendFileSync(join(root, 'peer-facts.jsonl'), JSON.stringify(value) + '\n');
const mcp = await httpFixture('defer-response', root);
const runtime = openOceanProfile(profile, true);
await runtime.ready;
const workspaceId = 'ws_ocean',
  execute = runtime.conversations.execute.bind(runtime.conversations);
execute({ type: 'BindWorkspace', requestId: 'init', workspaceId, root: workspace });
const bots = ['dev', 'review'].map((handle) => {
  const result = execute({
    type: 'CreateBot',
    requestId: handle,
    workspaceId,
    handle,
    name: handle,
    role: 'Synthetic current GUI service qualification',
    provider: 'deepseek',
    model: 'deepseek-flash',
  });
  if (!result.ok) throw Error('seed bot failed');
  return result.value.data;
});
const result = execute({
  type: 'CreateGroupRoom',
  requestId: 'room',
  workspaceId,
  title: 'Service QA',
  botIds: bots.map((b) => b.id),
});
if (!result.ok) throw Error('seed room failed: ' + JSON.stringify(result));
const roomId = result.value.data.id;
runtime.plugins.connections.add({
  id: 'legacy-archive',
  name: 'archive',
  pluginId: 'github',
  pluginVersion: '1.0.0',
  adapterVersion: 'legacy-synthetic',
  endpoint: mcp.url.href,
  credentialReference: 'LEGACY_SYNTHETIC_KEY',
  accountLabel: 'archive account',
  identity: 'old-account',
  identityVerified: true,
  state: 'disconnected',
  generation: 4,
  schemaDigest: null,
  tools: null,
  consentedGeneration: null,
  consentedAt: null,
  lastDiscoveryAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
runtime.close();
let modelCalls = 0;
const provider = {
  id: 'deepseek',
  models: ['deepseek-flash'],
  capabilities: { streaming: true, reasoning: false, usage: false, toolCalls: true },
  async *stream(request) {
    ++modelCalls;
    record({ kind: 'model', modelCalls });
    const tool = request.messages.at(-1);
    if (tool?.role === 'tool') {
      const result = JSON.parse(String(tool.content));
      if (result.structuredContent?.version !== 'alpha')
        throw Error('missing actual synthetic MCP result');
      yield { type: 'text_delta', text: 'verified alpha' };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'scripted' };
    } else {
      if (!request.tools?.[0]) throw Error('service tool missing');
      yield {
        type: 'tool_call',
        call: {
          id: 'actual-service-call',
          name: request.tools[0].name,
          arguments: JSON.stringify({
            value: 'alpha',
            echo: '<script>plain text</script>' + 'x'.repeat(40000),
          }),
        },
      };
      yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'scripted' };
    }
  },
};
const originalWrite = Socket.prototype.write;
Socket.prototype.write = function (chunk, ...rest) {
  if (Buffer.isBuffer(chunk) && chunk[0] === 123) {
    const reply = JSON.parse(chunk).result;
    if (reply?.method === 'service.connection-set' && reply.state === 'completed') {
      if (existsSync(join(root, 'drop-reply'))) {
        unlinkSync(join(root, 'drop-reply'));
        record({ kind: 'dropped-committed-reply', requestId: reply.requestId });
        this.destroy();
        return false;
      }
      if (existsSync(join(root, 'hold-reply'))) {
        unlinkSync(join(root, 'hold-reply'));
        record({ kind: 'held-committed-reply', requestId: reply.requestId });
        void (async () => {
          while (!existsSync(join(root, 'release-reply'))) await delay(20);
          originalWrite.call(this, chunk, ...rest);
        })();
        return true;
      }
    }
  }
  return originalWrite.call(this, chunk, ...rest);
};
const host = await startLocalRuntime({ profile, provider });
writeFileSync(
  join(root, 'owner-ready.json'),
  JSON.stringify({
    roomId,
    botId: bots[0].id,
    bots,
    endpoint: mcp.url.href,
    identity: host.identity,
  }),
);
console.log('ready');
let releaseDone = false;
const control = async () => {
  while (!releaseDone && !existsSync(join(root, 'release-effect'))) await delay(20);
  mcp.releaseResponse();
};
void control();
await host.closed;
releaseDone = true;
record({
  kind: 'final',
  modelCalls,
  mcp: mcp.stats,
  metadataCalls: mcp.rows.filter((m) => m === 'tools/list').length,
  methods: mcp.rows,
});
await mcp.close();
