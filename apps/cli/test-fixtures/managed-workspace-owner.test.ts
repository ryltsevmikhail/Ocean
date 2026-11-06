/* eslint-disable no-restricted-imports -- Built ordinary host qualification fixture. */
import type * as Host from '../src/local-runtime/host.js';
import type * as Profile from '../src/ocean/profile.js';
import { roomTaskHostFixture } from './room-task-host.ts';
import { serve } from './model-process-rpc.ts';
import { readFileSync, writeFileSync, watch, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createFetchHttpClient } from '@runnets/provider-core';
const { startLocalRuntime } = (await import(
  new URL('../dist/local-runtime/host.js', import.meta.url).href
)) as typeof Host;
const { openOceanProfile } = (await import(
  new URL('../dist/ocean/profile.js', import.meta.url).href
)) as typeof Profile;
const proof = process.argv[3]!;
if (process.argv[4] === 'barrier') {
  const sdk = (await import(
    new URL(
      '../../../packages/integrations-mcp/node_modules/@modelcontextprotocol/client/dist/stdio.mjs',
      import.meta.url,
    ).href
  )) as { StdioClientTransport: { prototype: { start(): Promise<void> } } };
  const start = sdk.StdioClientTransport.prototype.start;
  sdk.StdioClientTransport.prototype.start = async function () {
    writeFileSync(join(proof, 'pre-spawn-barrier'), 'committed lifetime; SDK spawn held');
    await new Promise<void>((resolve) => {
      const check = () => {
        if (existsSync(join(proof, 'spawn-release'))) {
          watcher.close();
          resolve();
        }
      };
      const watcher = watch(proof, check);
      check();
    });
    return Reflect.apply(start, this, []);
  };
}

let setup: {
  profile: string;
  root: string;
  input: Awaited<ReturnType<typeof roomTaskHostFixture>>['input'];
  bRoom: string;
};
if (process.argv[2] === 'new') {
  const f = await roomTaskHostFixture(true);
  const runtime = openOceanProfile(f.profile, true);
  await runtime.ready;
  const created = runtime.conversations.execute({
    type: 'CreateGroupRoom',
    requestId: 'b-room',
    workspaceId: 'ws_ocean',
    title: 'Independent B',
    botIds: f.botIds,
  });
  if (!created.ok || created.value.kind !== 'room') throw Error('independent room');
  setup = { profile: f.profile, root: f.root, input: f.input, bRoom: created.value.data.id };
  runtime.close();
  writeFileSync(join(proof, 'setup.json'), JSON.stringify(setup));
} else setup = JSON.parse(readFileSync(join(proof, 'setup.json'), 'utf8')) as typeof setup;
let requests = 0;
const http = createFetchHttpClient(async (_url, init) => {
  if (init.method === 'GET')
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }));
  const body = JSON.parse(String(init.body)) as {
    tools?: { function: { name: string } }[];
    messages: { role: string }[];
  };
  requests++;
  const tool = body.tools?.find((t) => t.function.name.startsWith('mcp_'))?.function.name;
  const call = body.messages.at(-1)?.role !== 'tool' && tool;
  const delta = call
    ? {
        tool_calls: [
          {
            index: 0,
            id: 'managed-write',
            type: 'function',
            function: { name: tool, arguments: '{}' },
          },
        ],
      }
    : { content: 'done' };
  return new Response(
    'data: ' +
      JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
const host = await startLocalRuntime({ profile: setup.profile, providerHttpClient: http });
process.send!({ ready: setup });
serve(async (method) => {
  if (method === 'requests') return requests;
  if (method === 'close') {
    await host.stop();
    return true;
  }
  throw Error('unknown method');
});
