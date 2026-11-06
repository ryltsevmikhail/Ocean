import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { HttpRequest } from '@runnets/provider-core';
import { roomTaskHostFixture } from '../../test-fixtures/room-task-host.js';
import { startLocalRuntime } from './host.js';
it('keeps owner collisions separate and exposes a valid public fence through SDK get/observe', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
  const f = await roomTaskHostFixture();
  let release!: () => void,
    entered!: () => void,
    first = true;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  const http = {
    async send(request: HttpRequest) {
      if (request.url.endsWith('/chat/completions') && first) {
        first = false;
        entered();
        await gate;
      }
      const response = await f.httpClient.send(request);
      return request.url.endsWith('/chat/completions')
        ? {
            ...response,
            async *stream() {
              for await (const chunk of response.stream())
                yield chunk.replaceAll('room_delegate', 'room_send');
            },
          }
        : response;
    },
  };
  const host = await startLocalRuntime({
      profile: f.profile,
      providerHttpClient: http,
      roomTaskCapacity: 1,
    }),
    client = await connectLocalRuntime({ profile: f.profile });
  try {
    const start = await client.roomTaskStart(f.input);
    await ready;
    const collision = 'room-fence/v1:' + createHash('sha256').update(start.rootId).digest('hex');
    const owner = await client.roomTaskStart({ ...f.input, requestId: collision });
    release();
    const q = { workspaceId: f.input.workspaceId, roomId: f.roomId, rootId: start.rootId };
    let view = await client.roomTaskGet(q);
    for (let i = 0; view.status !== 'paused' && i < 300; i++) {
      await delay(5);
      view = await client.roomTaskGet(q);
    }
    expect(view.status).toBe('paused');
    expect(view.fenceReason).toMatchObject({ code: 'duplicate_exchange' });
    expect(view.fenceReason!.id).not.toContain('\0');
    expect(view).not.toHaveProperty('decisionMark');
    expect((await client.roomTaskObserve(q)).view).toEqual(view);
    expect(await client.roomTaskStart({ ...f.input, requestId: collision })).toEqual(owner);
  } finally {
    release();
    client.close();
    await host.stop();
    f.dispose();
    vi.unstubAllEnvs();
  }
});
