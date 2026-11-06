import { expect, it } from 'vitest';
import * as contracts from './index.js';
it('refuses owner supplied actors and requires an explicit root scope', () => {
  expect(typeof contracts.isRoomTaskGet).toBe('function');
  expect(contracts.isRoomTaskGet({ workspaceId: 'ws', roomId: 'room' })).toBe(false);
  expect(contracts.isRoomTaskGet({ workspaceId: 'ws', roomId: 'room', rootId: 'root' })).toBe(true);
  expect(contracts.isRoomTaskStart({ workspaceId: 'ws', roomId: 'room', actor: 'owner' })).toBe(
    false,
  );
});
it('refuses coercible array and object scalar evidence in root and typed rows', () => {
  const task = {
    type: 'task',
    hold: null,
    id: 'task',
    parentId: null,
    botId: null,
    status: 'ready',
    waitingChildId: null,
  };
  expect(contracts.isRoomTaskRow(task)).toBe(true);
  expect(contracts.isRoomTaskRow({ ...task, status: ['ready'] })).toBe(false);
  expect(contracts.isRoomTaskRow({ ...task, type: { toString: () => 'task' } })).toBe(false);
  const slice = {
    type: 'slice',
    hold: null,
    taskId: 'task',
    deliveryId: 'delivery',
    runId: 'run',
    turnId: 'turn',
    turnStatus: 'completed',
    taskStatus: 'succeeded',
    version: 1,
    disposition: null,
    resultMessageId: null,
    pendingDecisionIds: [],
  };
  expect(contracts.isRoomTaskRow(slice)).toBe(true);
  expect(contracts.isRoomTaskRow({ ...slice, turnStatus: ['completed'] })).toBe(false);
  expect(contracts.isRoomTaskRow({ ...slice, taskStatus: 'invented' })).toBe(false);
});
