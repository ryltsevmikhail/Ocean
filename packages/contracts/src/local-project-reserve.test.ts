import { expect, it } from 'vitest';
import { isCodingTaskReserve, isCodingTaskReservation } from './local-project-reserve.js';
const request = {
  workspaceId: 'ws',
  projectId: 'p',
  requestId: 'r',
  taskId: 't',
  ownerRoomId: 'room',
  devBotId: 'dev',
  reviewRoomId: 'review',
  reviewBotId: 'review',
};
it('refuses inherited fields and undeclared authority in reserve input', () => {
  expect(isCodingTaskReserve(request)).toBe(true);
  const { projectId, ...own } = request;
  expect(
    isCodingTaskReserve(Object.assign(Object.create({ projectId }), own, { extra: true })),
  ).toBe(false);
  expect(isCodingTaskReserve({ ...request, allow: true })).toBe(false);
});
it('requires an allowed decision before claiming a reserved result', () => {
  const decision = {
    workspaceId: 'ws',
    roomId: 'room',
    runId: 't',
    decisionId: 'd',
    kind: 'project-setup',
    status: 'pending',
    version: 1,
    bindingDigest: 'a'.repeat(64),
    createdAt: 1,
    expiresAt: 300001,
    previewLength: 2,
  };
  const task = {
    id: 't',
    status: 'reserved',
    ownerRoomId: 'room',
    devBotId: 'dev',
    reviewRoomId: 'review',
    reviewBotId: 'review',
  };
  expect(isCodingTaskReservation({ status: 'reserved', decision, task })).toBe(false);
  expect(
    isCodingTaskReservation({
      status: 'reserved',
      decision: { ...decision, status: 'allowed', version: 2 },
      task,
    }),
  ).toBe(true);
});
