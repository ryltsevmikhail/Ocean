import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { RoomTaskStart, RoomTaskReceipt, RoomTaskRootView } from '@runnets/contracts';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { roomTaskOutageEvidence } from '../../test-fixtures/room-task-outage.js';
it.each(['cloud', 'local'] as const)(
  'built owner and two SDK peers preserve pins without fallback during synthetic %s outage',
  async (failed) => {
    const env = { ...process.env, DEEPSEEK_API_KEY: 'fixture-room-tasks' },
      owner = child('room-task-process-owner.test.ts', [failed + '-outage'], env);
    const ready = (await owner.ready) as { profile: string; input: RoomTaskStart };
    const peers = [
      child('room-task-process-peer.test.ts', [ready.profile], env),
      child('room-task-process-peer.test.ts', [ready.profile], env),
    ];
    try {
      await Promise.all(peers.map((p) => p.ready));
      const started = await peers[0]!.call<RoomTaskReceipt>('start', ready.input),
        q = {
          workspaceId: ready.input.workspaceId,
          roomId: ready.input.roomId,
          rootId: started.rootId,
        };
      let view = await peers[0]!.call<RoomTaskRootView>('get', q);
      for (
        let i = 0;
        !view.rows.some((r) => r.type === 'slice' && r.turnStatus === 'uncertain') && i < 300;
        i++
      ) {
        await delay(5);
        view = await peers[0]!.call('get', q);
      }
      expect(view.rows.some((r) => r.type === 'slice' && r.turnStatus === 'uncertain')).toBe(true);
      expect(await peers[1]!.call('get', q)).toEqual(view);
      const expected =
        failed === 'cloud'
          ? [{ provider: 'cloud', model: 'deepseek-flash' }]
          : [
              { provider: 'cloud', model: 'deepseek-flash' },
              { provider: 'local', model: 'qwen3:1.7b' },
            ];
      expect(await owner.call('attempts')).toEqual(expected);
      const evidence = roomTaskOutageEvidence(ready.profile, started.rootId);
      expect(evidence.turns).toHaveLength(expected.length);
      for (const turn of evidence.turns)
        expect(turn.activation!.identity).toEqual(
          evidence.pins.find((p) => p.botId === turn.bot.id)!.identity,
        );
      expect(evidence.pins.map((p) => p.identity.modelId)).toEqual([
        'deepseek-flash',
        'qwen3:1.7b',
      ]);
      expect(await peers[1]!.call('start', ready.input)).toEqual(started);
      expect(roomTaskOutageEvidence(ready.profile, started.rootId)).toEqual(evidence);
      expect(await owner.call('attempts')).toEqual(expected);
    } finally {
      for (const peer of peers) await peer.kill();
      await owner.call('close');
      await owner.kill();
    }
  },
  20000,
);
