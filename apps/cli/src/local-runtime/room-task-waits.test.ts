import { expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { connectLocalRuntime } from '@runnets/tools-node';
import { RuntimeObservers } from './observe.js';
import { startLocalRuntime } from './host.js';
import { roomTaskHostFixture } from '../../test-fixtures/room-task-host.js';
it.each(['peer', 'host'] as const)(
  'shares %s wait capacity across ordinary and root observers',
  async (limit) => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
    const closed = vi.spyOn(RuntimeObservers.prototype, 'close');
    const f = await roomTaskHostFixture(),
      host = await startLocalRuntime({ profile: f.profile, providerHttpClient: f.httpClient });
    const clients = await Promise.all(
      Array.from({ length: limit === 'peer' ? 1 : 9 }, () =>
        connectLocalRuntime({ profile: f.profile }),
      ),
    );
    const first = clients[0]!,
      pending: Promise<unknown>[] = [];
    try {
      const started = await first.roomTaskStart(f.input),
        q = { workspaceId: f.input.workspaceId, roomId: f.roomId, rootId: started.rootId };
      let view = await first.roomTaskGet(q);
      for (let i = 0; view.status !== 'completed' && i < 300; i++) {
        await delay(5);
        view = await first.roomTaskGet(q);
      }
      expect(view.status).toBe('completed');
      const peers = limit === 'peer' ? clients : clients.slice(0, 8);
      for (const client of peers) {
        const room = { workspaceId: q.workspaceId, roomId: q.roomId };
        const ordinary = await client.observeRoom(room),
          root = await client.roomTaskObserve(q);
        for (let i = 0; i < 2; i++) {
          pending.push(
            client
              .observeRoom({ ...room, cursor: ordinary.cursor, waitMs: 10000 })
              .catch((e: unknown) => e),
          );
          pending.push(
            client
              .roomTaskObserve({ ...q, cursor: root.cursor, waitMs: 10000 })
              .catch((e: unknown) => e),
          );
        }
      }
      // Socket ordering ensures all prior waits were admitted before this request.
      for (const client of peers) await client.roomTaskGet(q);
      const extra = clients.at(-1)!,
        root = await extra.roomTaskObserve(q);
      await expect(
        extra.roomTaskObserve({ ...q, cursor: root.cursor, waitMs: 10000 }),
      ).rejects.toThrow('observer_busy');
    } finally {
      for (const client of clients) client.close();
      await Promise.all(pending);
      await host.stop();
      expect(closed).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
      f.dispose();
      vi.unstubAllEnvs();
    }
  },
  20000,
);
