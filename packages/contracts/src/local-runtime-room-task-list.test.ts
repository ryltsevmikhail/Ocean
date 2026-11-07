import { expect, it } from 'vitest';
import * as c from './index.js';
const scope = { workspaceId: 'ws', roomId: 'room' };
const root = {
  rootId: 'root',
  startMessageId: 'message',
  startSeq: 2,
  status: 'ready',
  revision: 0,
  authority: 'current',
};
it('defines the single independent list feature and exact bounded request', () => {
  expect(c.LOCAL_ROOM_TASK_LIST).toBe('room.task-list-v1');
  expect(c.LOCAL_ROOM_TASK_METHODS).toHaveLength(4);
  for (const limit of [undefined, 1, 50])
    expect(
      c.isRoomTaskList({ ...scope, ...(limit === undefined ? {} : { limit }), beforeSeq: 1 }),
    ).toBe(true);
  for (const bad of [
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { beforeSeq: 0 },
    { beforeSeq: Number.MAX_SAFE_INTEGER + 1 },
    { ownerId: 'owner' },
    { rootId: 'root' },
  ])
    expect(c.isRoomTaskList({ ...scope, ...bad })).toBe(false);
});
it('accepts only closed summary pages with ordered unique canonical start evidence', () => {
  const page = { ...scope, roots: [root], nextBeforeSeq: 2 };
  expect(c.isRoomTaskListPage(page)).toBe(true);
  expect(
    c.isRoomTaskListPage({
      ...scope,
      roots: [
        root,
        { ...root, rootId: 'other', startMessageId: 'older', startSeq: 1, authority: 'historical' },
      ],
      nextBeforeSeq: null,
    }),
  ).toBe(true);
  for (const bad of [
    { ...page, extra: true },
    { ...page, roots: [{ ...root, prompt: 'secret' }] },
    { ...page, roots: [{ ...root, revision: -1 }] },
    { ...page, roots: [{ ...root, status: ['ready'] }] },
    { ...page, roots: [{ ...root, authority: 'adopted' }] },
    { ...page, roots: [{ ...root, startSeq: 0 }] },
    { ...page, roots: [root, root] },
    { ...page, roots: [root, { ...root, rootId: 'other', startSeq: 3 }] },
    { ...page, roots: [root, { ...root, rootId: 'other', startSeq: 1 }] },
    { ...page, nextBeforeSeq: 1 },
    { ...page, roots: [], nextBeforeSeq: 1 },
    {
      ...page,
      roots: Array.from({ length: 51 }, (_, i) => ({
        ...root,
        rootId: `r${i}`,
        startMessageId: `m${i}`,
        startSeq: 100 - i,
      })),
      nextBeforeSeq: null,
    },
  ])
    expect(c.isRoomTaskListPage(bad)).toBe(false);
  expect(c.isRoomTaskListPage({ ...scope, roots: [], nextBeforeSeq: null })).toBe(true);
});
