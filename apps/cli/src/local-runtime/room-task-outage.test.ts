import { expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime } from './host.js';
import { roomTaskHostFixture } from '../../test-fixtures/room-task-host.js';
import {
  roomTaskOutageHttp,
  roomTaskOutageEvidence,
} from '../../test-fixtures/room-task-outage.js';
it.each(['cloud', 'local'] as const)(
  'keeps original pins and makes no substitute send during a synthetic %s outage',
  async (failed) => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-room-tasks');
    const f = await roomTaskHostFixture(),
      outage = roomTaskOutageHttp(f.httpClient, failed);
    const host = await startLocalRuntime({
      profile: f.profile,
      providerHttpClient: outage.http,
      roomTaskCapacity: 1,
    });
    const client = await connectLocalRuntime({ profile: f.profile });
    try {
      const started = await client.roomTaskStart(f.input),
        q = { workspaceId: f.input.workspaceId, roomId: f.roomId, rootId: started.rootId };
      let view = await client.roomTaskGet(q);
      for (
        let i = 0;
        !view.rows.some((r) => r.type === 'slice' && r.turnStatus === 'uncertain') && i < 300;
        i++
      ) {
        await delay(5);
        view = await client.roomTaskGet(q);
      }
      expect(view.rows.some((r) => r.type === 'slice' && r.turnStatus === 'uncertain')).toBe(true);
      expect(outage.attempts).toEqual(
        failed === 'cloud'
          ? [{ provider: 'cloud', model: 'deepseek-flash' }]
          : [
              { provider: 'cloud', model: 'deepseek-flash' },
              { provider: 'local', model: 'qwen3:1.7b' },
            ],
      );
      const evidence = roomTaskOutageEvidence(f.profile, started.rootId);
      expect(evidence.turns).toHaveLength(failed === 'cloud' ? 1 : 2);
      for (const turn of evidence.turns)
        expect(turn.activation!.identity).toEqual(
          evidence.pins.find((p) => p.botId === turn.bot.id)!.identity,
        );
      expect(evidence.pins.map((p) => p.identity.modelId)).toEqual([
        'deepseek-flash',
        'qwen3:1.7b',
      ]);
      expect(await client.roomTaskStart(f.input)).toEqual(started);
      await client.roomTaskObserve(q);
      expect(roomTaskOutageEvidence(f.profile, started.rootId)).toEqual(evidence);
      expect(outage.attempts).toHaveLength(failed === 'cloud' ? 1 : 2);
    } finally {
      client.close();
      await host.stop();
      f.dispose();
      vi.unstubAllEnvs();
    }
  },
);
