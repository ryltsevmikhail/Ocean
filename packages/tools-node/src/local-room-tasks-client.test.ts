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
const listScope = { workspaceId: 'ws', roomId: 'room' };
const summary = {
  rootId: 'root',
  startMessageId: 'message',
  startSeq: 4,
  status: 'ready',
  revision: 1,
  authority: 'current',
};
const listIdentity = {
  protocol: 1 as const,
  profileId: 'a'.repeat(64),
  instanceId: 'a'.repeat(36),
  capabilities: ['room.tasks-v1', 'room.addressed-history-v1', 'room.task-list-v1'],
};
it.each(['room.tasks-v1', 'room.addressed-history-v1', 'room.task-list-v1'])(
  'refuses list without negotiated %s before sending',
  async (missing) => {
    let calls = 0;
    const sdk = localRoomTasksClient(
      async () => {
        calls++;
        return null;
      },
      {
        ...listIdentity,
        capabilities: listIdentity.capabilities.filter((c) => c !== missing),
      },
    );
    await expect(sdk.roomTaskList(listScope)).rejects.toThrow('client_upgrade_required');
    expect(calls).toBe(0);
  },
);
it.each(['foreign', 'workspace', 'overflow', 'cursor', 'duplicate', 'order', 'extra'])(
  'rejects %s list replies without downgrading',
  async (mode) => {
    const page = {
      ...listScope,
      workspaceId: mode === 'workspace' ? 'other' : 'ws',
      roomId: mode === 'foreign' ? 'other' : 'room',
      roots:
        mode === 'overflow' || mode === 'duplicate' || mode === 'order'
          ? [
              summary,
              {
                ...summary,
                rootId: mode === 'duplicate' ? 'root' : 'other',
                startMessageId: 'other',
                startSeq: mode === 'order' ? 5 : 3,
              },
            ]
          : [{ ...summary, ...(mode === 'extra' ? { prompt: 'secret' } : {}) }],
      nextBeforeSeq: null,
    };
    const sdk = localRoomTasksClient(async () => page, listIdentity);
    await expect(
      sdk.roomTaskList({
        ...listScope,
        limit: mode === 'overflow' ? 1 : 50,
        beforeSeq: mode === 'cursor' ? 4 : 6,
      }),
    ).rejects.toThrow('invalid_frame');
  },
);
it('sends one bounded exclusive list request and preserves the typed page', async () => {
  const q = { ...listScope, beforeSeq: 5, limit: 1 };
  const page = { ...listScope, roots: [summary], nextBeforeSeq: 4 };
  const sdk = localRoomTasksClient(async (method, params) => {
    expect(method).toBe('roomTasks.list');
    expect(params).toEqual(q);
    return page;
  }, listIdentity);
  expect(await sdk.roomTaskList(q)).toEqual(page);
});
