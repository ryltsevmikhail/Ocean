import { expect, it } from 'vitest';
import { isCodingTaskPrepare, isCodingTaskPreparation } from './local-project-prepare.js';
const request = {
  workspaceId: 'ws',
  roomId: 'room',
  taskId: 'task',
  requestId: 'request',
  expectedPolicyVersion: 1,
};
const worktree = {
  workspaceId: 'ws',
  taskId: 'task',
  projectRoot: '/project',
  baseCommit: 'a'.repeat(40),
  root: '/worktree',
  branch: 'branch',
  gitCommonDir: '/project/.git',
  state: 'ready',
};
const decision = {
  workspaceId: 'ws',
  roomId: 'room',
  runId: 'run',
  decisionId: 'decision',
  kind: 'project-setup',
  status: 'allowed',
  version: 2,
  bindingDigest: 'a'.repeat(64),
  createdAt: 1,
  expiresAt: 300001,
  previewLength: 2,
};
it('accepts only exact prepare identifiers and policy version without supplied authority', () => {
  expect(isCodingTaskPrepare(request)).toBe(true);
  for (const change of [
    { botId: 'dev' },
    { projectRoot: '/project' },
    { allow: true },
    { expectedPolicyVersion: 0 },
    { expectedPolicyVersion: 1.5 },
  ])
    expect(isCodingTaskPrepare({ ...request, ...change })).toBe(false);
  const { roomId, ...own } = request;
  expect(isCodingTaskPrepare(Object.assign(Object.create({ roomId }), own, { extra: true }))).toBe(
    false,
  );
});
it('separates exact prepared proof, existing facts and owner decisions', () => {
  expect(isCodingTaskPreparation({ status: 'prepared', decision, worktree })).toBe(true);
  expect(
    isCodingTaskPreparation({
      status: 'prepared',
      decision: { ...decision, status: 'pending' },
      worktree,
    }),
  ).toBe(false);
  expect(isCodingTaskPreparation({ status: 'existing', decision: null, worktree })).toBe(true);
  expect(isCodingTaskPreparation({ status: 'existing', decision, worktree })).toBe(false);
  expect(
    isCodingTaskPreparation({
      status: 'prepared',
      decision,
      worktree: { ...worktree, lease: 'secret' },
    }),
  ).toBe(false);
  const { state, ...own } = worktree;
  expect(
    isCodingTaskPreparation({
      status: 'existing',
      decision: null,
      worktree: Object.assign(Object.create({ state }), own, { extra: true }),
    }),
  ).toBe(false);
});
