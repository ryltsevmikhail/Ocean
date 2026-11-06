import { expect, it } from 'vitest';
import { localRoomTasksClient } from './local-room-tasks-client.js';
import type { RoomTaskRootView } from '@runnets/contracts';
const scope = { workspaceId: 'ws', roomId: 'room', rootId: 'root' };
const task = (id: string) => ({
  type: 'task' as const,
  hold: null,
  id,
  parentId: null,
  botId: null,
  status: 'ready' as const,
  waitingChildId: null,
});
const view: RoomTaskRootView = {
  ...scope,
  status: 'ready',
  revision: 1,
  fenceReason: null,
  counts: { active: 0, slices: 0, modelStarts: 0, toolCalls: 0 },
  rows: [task('a')],
  nextPage: 'page',
};
it.each(['duplicate', 'reordered', 'changed', 'foreign', 'extra'] as const)(
  'rejects %s root pages from a peer',
  async (mode) => {
    let calls = 0;
    const sdk = localRoomTasksClient(
      async () =>
        calls++ === 0
          ? view
          : {
              ...view,
              rootId: mode === 'foreign' ? 'foreign' : 'root',
              rows: [task(mode === 'reordered' ? '0' : mode === 'duplicate' ? 'a' : 'b')],
              counts: { ...view.counts, slices: mode === 'changed' ? 1 : 0 },
              ...(mode === 'extra' ? { authority: 'forged' } : {}),
              nextPage: null,
            },
      {
        protocol: 1,
        profileId: 'a'.repeat(64),
        instanceId: 'a'.repeat(36),
        capabilities: ['room.tasks-v1', 'room.addressed-history-v1'],
      },
    );
    await expect(sdk.roomTaskGet(scope)).rejects.toThrow('invalid_frame');
  },
);
it('follows typed ordered scope-bound root pages', async () => {
  let calls = 0;
  const sdk = localRoomTasksClient(
    async () => (calls++ === 0 ? view : { ...view, rows: [task('b')], nextPage: null }),
    {
      protocol: 1,
      profileId: 'a'.repeat(64),
      instanceId: 'a'.repeat(36),
      capabilities: ['room.tasks-v1', 'room.addressed-history-v1'],
    },
  );
  expect((await sdk.roomTaskGet(scope)).rows).toEqual([task('a'), task('b')]);
  expect(calls).toBe(2);
});
