import { expect, it } from 'vitest';
import type {
  RoomTaskStart,
  RoomTaskReceipt,
  RoomTaskRootView,
  RoomTaskStopReceipt,
} from '@runnets/contracts';
import { child } from '../../test-fixtures/model-process-rpc.ts';
it('replays lost start and stop acknowledgements across separate built SDK peers without new effects', async () => {
  const env = { ...process.env, DEEPSEEK_API_KEY: 'fixture-room-tasks' };
  const owner = child('room-task-process-owner.test.ts', ['hold'], env),
    ready = (await owner.ready) as { profile: string; input: RoomTaskStart };
  let peer = child('room-task-process-peer.test.ts', [ready.profile], env);
  try {
    await peer.ready;
    await owner.call('drop-start');
    await expect(peer.call('start', ready.input)).rejects.toThrow('connection_closed');
    await peer.kill();
    peer = child('room-task-process-peer.test.ts', [ready.profile], env);
    await peer.ready;
    const receipt = await peer.call<RoomTaskReceipt>('start', ready.input);
    await expect(peer.call('start', { ...ready.input, text: 'altered' })).rejects.toThrow(
      'request_conflict',
    );
    await owner.call('held');
    const scope = {
      workspaceId: ready.input.workspaceId,
      roomId: ready.input.roomId,
      rootId: receipt.rootId,
    };
    let view = await peer.call<RoomTaskRootView>('get', scope);
    expect(view.status).toBe('ready');
    await owner.call('drop-stop');
    const stop = { ...scope, requestId: 'stop', expectedRevision: view.revision };
    await expect(peer.call('stop', stop)).rejects.toThrow('connection_closed');
    await peer.kill();
    peer = child('room-task-process-peer.test.ts', [ready.profile], env);
    await peer.ready;
    const stopped = await peer.call<RoomTaskStopReceipt>('stop', stop);
    expect(stopped.status).toBe('stopped');
    view = await peer.call('get', scope);
    expect(view.status).toBe('stopped');
    expect(await peer.call('start', ready.input)).toEqual(receipt);
  } finally {
    await peer.kill();
    await owner.call('close');
    await owner.kill();
  }
}, 20000);
