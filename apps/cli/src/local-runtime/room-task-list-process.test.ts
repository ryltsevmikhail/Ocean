import { expect, it } from 'vitest';
import type {
  RoomTaskListPage,
  RoomTaskReceipt,
  RoomTaskRootView,
  RoomTaskStart,
} from '@runnets/contracts';
import { child } from '../../test-fixtures/model-process-rpc.ts';
import { setTimeout as delay } from 'node:timers/promises';
it('discovers a lost-ACK start through two public SDK peers before and after owner restart without replay or effects', async () => {
  const env = { ...process.env, DEEPSEEK_API_KEY: 'fixture-room-tasks' };
  const owner = child('room-task-process-owner.test.ts', [], env);
  const ready = (await owner.ready) as {
    profile: string;
    input: RoomTaskStart;
    instanceId: string;
  };
  let a = child('room-task-process-peer.test.ts', [ready.profile], env);
  let b = child('room-task-process-peer.test.ts', [ready.profile], env);
  const q = { workspaceId: ready.input.workspaceId, roomId: ready.input.roomId };
  try {
    await Promise.all([a.ready, b.ready]);
    await owner.call('drop-start');
    await expect(a.call('start', ready.input)).rejects.toThrow('connection_closed');
    const found = await b.call<RoomTaskListPage>('list', q);
    expect(found.roots).toHaveLength(1);
    const summary = found.roots[0]!;
    expect(summary.authority).toBe('current');
    const scope = { ...q, rootId: summary.rootId };
    let view = await b.call<RoomTaskRootView>('get', scope);
    for (let i = 0; view.status !== 'completed' && i < 1000; i++) {
      await delay(5);
      view = await b.call('get', scope);
    }
    expect(view.status).toBe('completed');
    expect(await owner.call<string[]>('requests')).toHaveLength(3);
    const settled = await owner.call('snapshot');
    const first = await b.call<RoomTaskListPage>('list', q);
    expect(first.roots[0]).toEqual({ ...summary, status: view.status, revision: view.revision });
    expect(await owner.call('snapshot')).toEqual(settled);
    await a.kill();
    await b.kill();
    expect(await owner.call('restart')).not.toBe(ready.instanceId);
    a = child('room-task-process-peer.test.ts', [ready.profile], env);
    b = child('room-task-process-peer.test.ts', [ready.profile], env);
    await Promise.all([a.ready, b.ready]);
    const restarted = await owner.call('snapshot');
    expect(await a.call('list', q)).toEqual(first);
    expect(await b.call('list', q)).toEqual(first);
    expect(await owner.call('snapshot')).toEqual(restarted);
    const replay = await a.call<RoomTaskReceipt>('start', ready.input);
    expect(replay).toMatchObject({
      ...q,
      rootId: summary.rootId,
      messageId: summary.startMessageId,
      seq: summary.startSeq,
    });
    expect(await b.call('start', ready.input)).toEqual(replay);
    await expect(b.call('start', { ...ready.input, text: 'changed payload' })).rejects.toThrow(
      'request_conflict',
    );
    expect(await b.call('list', q)).toEqual(first);
    expect(await owner.call('snapshot')).toEqual(restarted);
    expect(await owner.call<string[]>('requests')).toHaveLength(3);
  } finally {
    await a.kill();
    await b.kill();
    await owner.call('close');
    await owner.kill();
  }
}, 20000);
