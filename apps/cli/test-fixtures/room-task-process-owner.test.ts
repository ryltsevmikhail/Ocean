import { roomTaskOutageHttp } from './room-task-outage.ts';
/* eslint-disable no-restricted-imports -- CLI fixture imports host module types from its own package. */
import type { HttpRequest } from '@runnets/provider-core';
import type * as ModuleType1 from '../src/local-runtime/host.js';
import { roomTaskHostFixture } from './room-task-host.ts';
import { serve } from './model-process-rpc.ts';
import { join } from 'node:path';
import { Socket } from 'node:net';
const { startLocalRuntime } = (await import(
  new URL('../dist/local-runtime/host.js', import.meta.url).href
)) as typeof ModuleType1;
const { openSqliteStore } = await import('@runnets/store-sqlite');
const f = await roomTaskHostFixture(true);
const outage = roomTaskOutageHttp(
  f.httpClient,
  process.argv[2] === 'cloud-outage' ? 'cloud' : 'local',
);
const transport = process.argv[2]?.endsWith('-outage') ? outage.http : f.httpClient;
let drop: 'start' | 'stop' | null = null;
const write = Socket.prototype.write;
Socket.prototype.write = function (
  this: Socket,
  ...args: [
    string | Uint8Array,
    (BufferEncoding | ((err?: Error | null) => void))?,
    ((err?: Error | null) => void)?,
  ]
) {
  const chunk = args[0];
  if (Buffer.isBuffer(chunk) && chunk[0] === 123) {
    const result = (
      JSON.parse(chunk.toString()) as {
        result?: { rootId?: string; status?: string; deliveries?: unknown };
      }
    ).result;
    if (
      result?.rootId &&
      ((drop === 'start' && result.deliveries) || (drop === 'stop' && result.status === 'stopped'))
    ) {
      drop = null;
      this.destroy();
      return false;
    }
  }
  return Reflect.apply(write, this, args) as boolean;
};
let entered!: () => void;
const held = new Promise<void>((r) => {
  entered = r;
});
const http = {
  async send(request: HttpRequest) {
    if (process.argv[2] === 'hold' && request.url.endsWith('/api/version')) {
      entered();
      await new Promise<void>((_resolve, reject) => {
        if (request.signal?.aborted) reject(Error('cancelled metadata'));
        else
          request.signal?.addEventListener('abort', () => reject(Error('cancelled metadata')), {
            once: true,
          });
      });
    }
    const response = await transport.send(request);
    if (process.argv[2] === 'model-crash' && request.url.endsWith('/chat/completions'))
      return {
        ...response,
        async *stream() {
          entered();
          yield 'data: ' +
            JSON.stringify({
              choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
            }) +
            '\n\n';
          await new Promise<void>(() => {});
        },
      };
    if (process.argv[2] === 'service-crash' && request.url.endsWith('/chat/completions')) {
      const body = JSON.parse(request.body!) as { tools?: { function: { name: string } }[] };
      const name = body.tools?.find((tool) => tool.function.name.startsWith('mcp_'))?.function.name;
      if (!name) throw Error('marked service schema missing');
      const data = [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'service',
                    type: 'function',
                    function: { name, arguments: '{"value":"alpha"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      return {
        ...response,
        async *stream() {
          for (const value of data) yield 'data: ' + JSON.stringify(value) + '\n\n';
          yield 'data: [DONE]\n\n';
        },
      };
    }
    return response;
  },
};
let host = await startLocalRuntime({
  profile: f.profile,
  providerHttpClient: http,
  roomTaskCapacity: 1,
});
process.send!({
  ready: { profile: f.profile, input: f.input, instanceId: host.identity.instanceId },
});
serve(async (method) => {
  if (method === 'drop-start') {
    drop = 'start';
    return true;
  }
  if (method === 'drop-stop') {
    drop = 'stop';
    return true;
  }
  if (method === 'requests') return f.requests;
  if (method === 'attempts') return outage.attempts;
  if (method === 'held') {
    await held;
    return true;
  }
  if (method === 'restart') {
    await host.stop();
    host = await startLocalRuntime({
      profile: f.profile,
      providerHttpClient: f.httpClient,
      roomTaskCapacity: 1,
    });
    return host.identity.instanceId;
  }
  if (method === 'fence') {
    await host.stop();
    const store = openSqliteStore({ path: join(f.profile, 'runtime.sqlite') });
    store.conversations.atomic((tx) => {
      for (const root of tx.roomTasks!.roots())
        if (root.status === 'ready')
          tx.roomTasks!.advanceTask({ ...root, status: 'paused' }, root.revision);
    });
    store.close();
    host = await startLocalRuntime({
      profile: f.profile,
      providerHttpClient: f.httpClient,
      roomTaskCapacity: 1,
    });
    return true;
  }
  if (method === 'close') {
    await host.stop();
    f.dispose();
    return true;
  }
  throw Error('unknown fixture method');
});
