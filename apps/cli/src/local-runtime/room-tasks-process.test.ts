import { expect, it } from 'vitest';
import type {
  RoomTaskStart,
  RoomTaskReceipt,
  RoomTaskRootView,
  RoomTaskObservation,
} from '@runnets/contracts';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { setTimeout as delay } from 'node:timers/promises';
it('serves the same three-run root to two independent built SDK processes and resyncs after ordinary restart', async () => {
  const env = { ...process.env, DEEPSEEK_API_KEY: 'fixture-room-tasks' };
  const owner = child('room-task-process-owner.test.ts', [], env);
  const ready = (await owner.ready) as {
    profile: string;
    input: RoomTaskStart;
    instanceId: string;
  };
  let a = child('room-task-process-peer.test.ts', [ready.profile], env),
    b = child('room-task-process-peer.test.ts', [ready.profile], env);
  try {
    await Promise.all([a.ready, b.ready]);
    const start = await a.call<RoomTaskReceipt>('start', ready.input),
      scope = {
        workspaceId: ready.input.workspaceId,
        roomId: ready.input.roomId,
        rootId: start.rootId,
      };
    let view = await b.call<RoomTaskRootView>('get', scope);
    for (let i = 0; view.status !== 'completed' && i < 1000; i++) {
      await delay(5);
      view = await b.call('get', scope);
    }
    expect(view.status).toBe('completed');
    expect(await a.call('get', scope)).toEqual(view);
    expect(view.rows.filter((r) => r.type === 'slice')).toHaveLength(3);
    expect(view.rows.filter((r) => r.type === 'delivery' && r.kind === 'result')).toHaveLength(1);
    const before = await a.call<RoomTaskObservation>('observe', scope);
    await a.kill();
    await b.kill();
    const instance = await owner.call('restart');
    expect(instance).not.toBe(ready.instanceId);
    a = child('room-task-process-peer.test.ts', [ready.profile], env);
    b = child('room-task-process-peer.test.ts', [ready.profile], env);
    await Promise.all([a.ready, b.ready]);
    expect(await a.call('start', ready.input)).toEqual(start);
    expect(await b.call('get', scope)).toEqual(view);
    expect(await a.call('observe', { ...scope, cursor: before.cursor })).toMatchObject({
      kind: 'resync',
    });
    expect(await owner.call<string[]>('requests')).toHaveLength(3);
  } finally {
    await a.kill();
    await b.kill();
    await owner.call('close');
    await owner.kill();
  }
}, 20000);
