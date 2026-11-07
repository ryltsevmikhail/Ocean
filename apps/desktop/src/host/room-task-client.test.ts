import { expect, it } from 'vitest';
import {
  LOCAL_ROOM_TASKS,
  LOCAL_ADDRESSED_HISTORY,
  LOCAL_ROOM_TASK_LIST,
  LOCAL_ROOM_TASK_METHODS,
} from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node/local-runtime-client';
import { dispatch } from './runtime-client.js';
const binding = { profileId: 'a'.repeat(64), instanceId: '11111111-1111-4111-8111-111111111111' };
const input = { workspaceId: 'ws_ocean', roomId: 'r', rootId: 'root' };
const capabilities = [
  LOCAL_ROOM_TASKS,
  LOCAL_ADDRESSED_HISTORY,
  LOCAL_ROOM_TASK_LIST,
  ...LOCAL_ROOM_TASK_METHODS,
  'roomTasks.list',
];
it('rejects stale identity and downgraded capabilities before a task mutation reaches the SDK', async () => {
  let writes = 0;
  const client = (identity: object) =>
    ({
      identity,
      roomTaskStop: async () => {
        ++writes;
      },
    }) as unknown as LocalRuntimeClient;
  const command = {
    op: 'task-stop' as const,
    binding,
    input: { ...input, expectedRevision: 1, requestId: 'request' },
  };
  await expect(
    dispatch(client({ ...binding, profileId: 'b'.repeat(64), capabilities }), command),
  ).rejects.toThrow('task_identity_changed');
  await expect(
    dispatch(client({ ...binding, instanceId: crypto.randomUUID(), capabilities }), command),
  ).rejects.toThrow('task_identity_changed');
  await expect(
    dispatch(
      client({ ...binding, capabilities: capabilities.filter((x) => x !== LOCAL_ROOM_TASK_LIST) }),
      command,
    ),
  ).rejects.toThrow('task_runtime_upgrade_required');
  expect(writes).toBe(0);
});
it('rejects a structurally valid foreign SDK reply at the host boundary', async () => {
  const client = {
    identity: { ...binding, capabilities },
    roomTaskList: async () => ({
      workspaceId: 'ws_ocean',
      roomId: 'other',
      roots: [],
      nextBeforeSeq: null,
    }),
  } as unknown as LocalRuntimeClient;
  await expect(
    dispatch(client, { op: 'task-list', binding, input: { workspaceId: 'ws_ocean', roomId: 'r' } }),
  ).rejects.toThrow('invalid_frame');
});
it('accepts a complete SDK assembly of 51 rows while rejecting foreign, partial, duplicate and oversized assemblies', async () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({
    type: 'task',
    id: `task_${String(i).padStart(3, '0')}`,
    parentId: null,
    botId: 'a',
    status: 'ready',
    waitingChildId: null,
    hold: null,
  }));
  const view = {
    ...input,
    status: 'ready',
    revision: 1,
    fenceReason: null,
    counts: { active: 1, slices: 0, modelStarts: 0, toolCalls: 0 },
    nextPage: null,
    rows,
  };
  let reply: unknown = view;
  const client = {
    identity: { ...binding, capabilities },
    roomTaskGet: async () => reply,
  } as unknown as LocalRuntimeClient;
  const command = { op: 'task-get' as const, binding, input };
  await expect(dispatch(client, command)).resolves.toEqual(view);
  for (const bad of [
    { ...view, rootId: 'foreign' },
    { ...view, nextPage: 'partial' },
    { ...view, rows: [rows[0], rows[0]] },
    { ...view, rows: Array(513).fill(rows[0]) },
  ]) {
    reply = bad;
    await expect(dispatch(client, command)).rejects.toThrow('invalid_frame');
  }
});
