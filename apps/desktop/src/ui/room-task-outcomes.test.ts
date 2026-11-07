import { expect, it, vi } from 'vitest';
import type { RoomTaskRootView } from '@runnets/contracts';
import type { TaskCommand } from '../room-task-protocol.js';
import { createRoomTasks } from './room-task-state.js';
const binding = {
  profileId: 'a'.repeat(64),
  instanceId: '11111111-1111-4111-8111-111111111111',
  supported: true,
};
it.each(['ack', 'version_conflict'] as const)(
  'retires only the owning stop marker on late known %s without overwriting another room or its unknown stop',
  async (outcome) => {
    let finish!: () => void;
    let acknowledged = false;
    const request = vi.fn(async (c: TaskCommand | { op: 'service-grants' }) => {
      if (c.op === 'task-support') return binding;
      if (c.op === 'service-grants') return [];
      if (c.op === 'task-list')
        return {
          workspaceId: 'ws_ocean',
          roomId: c.input.roomId,
          roots: [
            {
              rootId: 'root',
              startMessageId: 'message',
              startSeq: 1,
              revision: 1,
              status: 'ready',
              authority: 'current',
            },
          ],
          nextBeforeSeq: null,
        };
      if (c.op === 'task-get')
        return {
          workspaceId: 'ws_ocean',
          roomId: c.input.roomId,
          rootId: 'root',
          status: acknowledged && c.input.roomId === 'r' ? 'stopped' : 'ready',
          revision: 1,
          fenceReason: null,
          counts: { active: 0, slices: 0, modelStarts: 0, toolCalls: 0 },
          rows: [],
          nextPage: null,
        } satisfies RoomTaskRootView;
      if (c.op === 'task-observe') return new Promise(() => {});
      if (c.op === 'task-stop') {
        if (c.input.roomId === 'other') throw Error('outcome_unknown');
        return new Promise((yes, no) => {
          finish = () => {
            if (outcome === 'version_conflict') no(Error(outcome));
            else {
              acknowledged = true;
              yes({ ...c.input, revision: c.input.expectedRevision + 1, status: 'stopped' });
            }
          };
        });
      }
      throw Error('unexpected');
    });
    const state = createRoomTasks(request as never);
    await state.context('r');
    const oldStop = state.stop();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await state.context('other');
    await state.stop();
    const message = state.message.value;
    expect(state.stopUnknown.value).toBe(true);
    finish();
    await oldStop;
    expect(state.view.value?.roomId).toBe('other');
    expect(state.stopReceipt.value).toBeNull();
    expect(state.message.value).toBe(message);
    expect(state.stopUnknown.value).toBe(true);
    await state.context('r');
    expect(state.stopUnknown.value).toBe(false);
    await state.context('other');
    expect(state.stopUnknown.value).toBe(true);
    state.close();
  },
);
it('treats an actual fresh stale-grant admission refusal as refused so reread and reselection remain possible', async () => {
  const request = vi.fn(async (c: TaskCommand | { op: 'service-grants' }) => {
    if (c.op === 'task-support') return binding;
    if (c.op === 'service-grants') return [];
    if (c.op === 'task-list')
      return { workspaceId: 'ws_ocean', roomId: 'r', roots: [], nextBeforeSeq: null };
    if (c.op === 'task-start') throw Error('approval_required');
    throw Error('unexpected');
  });
  const state = createRoomTasks(request as never);
  await state.context('r');
  await state.start({
    text: 'text',
    initialBotIds: ['a'],
    participants: [{ botId: 'a', grantReferences: [] }],
    mandate: { projectId: null, codingTaskId: null, permissions: [] },
  });
  expect(state.pending.value).toBeNull();
  expect(state.message.value).toContain('отклонено');
  expect(state.message.value).toContain('approval_required');
  state.close();
});
it('retires a late fresh start refusal in its owning room while leaving the other room unknown and untouched', async () => {
  let refuse!: () => void;
  const request = vi.fn(async (c: TaskCommand | { op: 'service-grants' }) => {
    if (c.op === 'task-support') return binding;
    if (c.op === 'service-grants') return [];
    if (c.op === 'task-list')
      return { workspaceId: 'ws_ocean', roomId: c.input.roomId, roots: [], nextBeforeSeq: null };
    if (c.op === 'task-start') {
      if (c.input.roomId === 'other') throw Error('outcome_unknown');
      return new Promise((_yes, no) => {
        refuse = () => no(Error('approval_required'));
      });
    }
    throw Error('unexpected');
  });
  const draft = {
    text: 'text',
    initialBotIds: ['a'],
    participants: [{ botId: 'a', grantReferences: [] }],
    mandate: { projectId: null, codingTaskId: null, permissions: [] },
  };
  const state = createRoomTasks(request as never);
  await state.context('r');
  const oldStart = state.start(draft);
  await vi.waitFor(() => expect(refuse).toBeDefined());
  await state.context('other');
  await state.start(draft);
  const message = state.message.value;
  refuse();
  await oldStart;
  expect(state.pending.value?.input.roomId).toBe('other');
  expect(state.message.value).toBe(message);
  await state.context('r');
  expect(state.pending.value).toBeNull();
  await state.context('other');
  expect(state.pending.value?.input.roomId).toBe('other');
  state.close();
});
