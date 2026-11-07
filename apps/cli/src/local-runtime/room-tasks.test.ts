import type { HttpRequest } from '@runnets/provider-core';
import { expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime } from './host.js';
import { roomTaskHostFixture } from '../../test-fixtures/room-task-host.js';
it('executes owner A→B→A through the ordinary authenticated host and shared engine', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
  const f = await roomTaskHostFixture();
  const host = await startLocalRuntime({
    profile: f.profile,
    providerHttpClient: f.httpClient,
    roomTaskCapacity: 1,
  });
  const client = await connectLocalRuntime({ profile: f.profile });
  try {
    expect(client.identity.capabilities).toContain('room.tasks-v1');
    const start = await client.roomTaskStart(f.input);
    const q = { workspaceId: 'ws_ocean', roomId: f.roomId, rootId: start.rootId };
    let view = await client.roomTaskGet(q);
    const until = Date.now() + 10000;
    while (view.status !== 'completed' && Date.now() < until) {
      await delay(10);
      view = await client.roomTaskGet(q);
    }
    expect(view.status).toBe('completed');
    expect(f.requests).toHaveLength(3);
    expect(JSON.parse(f.requests[1]!)).toMatchObject({
      model: 'qwen3:1.7b',
      options: { num_ctx: 4096 },
    });
    expect(JSON.parse(f.requests[1]!)).not.toHaveProperty('tools');
    expect(f.metadata.filter((path) => path === '/api/show')).toHaveLength(2);
    const slices = view.rows.filter((r) => r.type === 'slice');
    expect(slices).toHaveLength(3);
    expect(slices.filter((r) => r.disposition === 'yielded')).toHaveLength(1);
    expect(slices.filter((r) => r.disposition === 'yielded')[0]?.resultMessageId).toBeNull();
    expect(view.rows.filter((r) => r.type === 'delivery' && r.kind === 'result')).toHaveLength(1);
    expect(f.requests[2]).toContain('B done');
    expect(await client.roomTaskStart(f.input)).toEqual(start);
    expect(f.requests).toHaveLength(3);
  } finally {
    client.close();
    await host.stop();
    f.dispose();
    vi.unstubAllEnvs();
  }
});
it('fills both host slots for independent initial tasks under the same root', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
  const f = await roomTaskHostFixture();
  let entered = 0,
    release!: () => void,
    twice!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    both = new Promise<void>((r) => {
      twice = r;
    });
  const http = {
    async send(r: HttpRequest) {
      if (r.url.endsWith('/chat/completions') || r.url.endsWith('/api/chat')) {
        entered++;
        if (entered === 2) twice();
        await gate;
      }
      return f.httpClient.send(r);
    },
  };
  const host = await startLocalRuntime({ profile: f.profile, providerHttpClient: http }),
    client = await connectLocalRuntime({ profile: f.profile });
  try {
    const start = await client.roomTaskStart({ ...f.input, initialBotIds: f.botIds });
    expect(await Promise.race([both.then(() => true), delay(1000).then(() => false)])).toBe(true);
    release();
    const q = { workspaceId: 'ws_ocean', roomId: f.roomId, rootId: start.rootId };
    let view = await client.roomTaskGet(q);
    const deadline = Date.now() + 10000;
    while (view.status !== 'completed' && Date.now() < deadline) {
      await delay(10);
      view = await client.roomTaskGet(q);
    }
    expect(view.status).toBe('completed');
  } finally {
    release();
    client.close();
    await host.stop();
    f.dispose();
    vi.unstubAllEnvs();
  }
});
