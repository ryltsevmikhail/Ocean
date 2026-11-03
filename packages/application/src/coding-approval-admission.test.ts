import { expect, it } from 'vitest';
import type { CodingApprovalBinding, CodingTask } from '@runnets/domain';
import { codingApprovalAdmission } from './coding-approval-admission.js';
const binding: CodingApprovalBinding = {
  workspaceId: 'w',
  taskId: 't',
  projectRoot: '/p',
  worktreeRoot: '/wt',
  roomId: 'r',
  botId: 'b',
  runId: 'run',
  attemptId: 'a',
  invocationId: 'i',
  operation: 'write',
  operationHash: 'patch',
  sourceTreeHash: 'tree',
  policyVersion: 1,
  limitsHash: 'limits',
  toolchainHash: 'tools',
};
const task: CodingTask = {
  id: 't',
  workspaceId: 'w',
  projectRoot: '/p',
  worktreeRoot: '/wt',
  baseCommit: 'base',
  ownerRoomId: 'r',
  devBotId: 'b',
  reviewBotId: 'review',
  reviewRoomId: 'review-room',
  status: 'reserved',
  policyVersion: 1,
  policy: {
    version: 1,
    devCapabilities: ['propose_write'],
    reviewCapabilities: ['changeset_read'],
    testPresets: [],
  },
  lease: {
    ownerId: 'owner',
    taskId: 't',
    requestId: 'request',
    binding: 'binding',
    kind: 'coding',
    projectRoot: '/p',
    token: 'token',
  },
  createdAt: '2026-11-02',
};
it('requires authoritative task scope current membership live lease and no unresolved claims', () => {
  let pending = false,
    owns = true,
    member = true;
  const tx = {
    task: () => task,
    worktree: () => ({
      taskId: task.id,
      workspaceId: task.workspaceId,
      root: '/wt',
      branch: 'task',
      gitCommonDir: '/p/.git',
      projectRoot: '/p',
      baseCommit: task.baseCommit,
      state: 'ready' as const,
      lease: { ...task.lease, projectRoot: '/wt' },
    }),
    participates: () => member,
    approval: () => null,
    putApproval: () => {},
    claimApprovalOperation: () => false,
  };
  const deps = {
    ownerId: 'owner',
    leases: {
      owns: () => owns,
      acquire: () => {
        throw Error('unused');
      },
      release: () => false,
    },
    journal: {
      claim: async () => false,
      settle: async () => {},
      pending: async () => [],
      recover: async () => {},
      inspectPending: () =>
        pending
          ? [
              {
                id: 'unknown',
                taskRunId: 'run',
                attemptId: 'a',
                fingerprint: 'f',
                tool: 'command',
                outcome: 'uncertain' as const,
              },
            ]
          : [],
    },
  };
  expect(codingApprovalAdmission(binding, tx, deps)).toBe(true);
  for (const changed of [
    { roomId: 'foreign' },
    { botId: 'review' },
    { worktreeRoot: '/other' },
    { operation: 'apply' as const },
  ])
    expect(codingApprovalAdmission({ ...binding, ...changed }, tx, deps)).toBe(false);
  pending = true;
  expect(codingApprovalAdmission(binding, tx, deps)).toBe(false);
  pending = false;
  owns = false;
  expect(codingApprovalAdmission(binding, tx, deps)).toBe(false);
  owns = true;
  member = false;
  expect(codingApprovalAdmission(binding, tx, deps)).toBe(false);
});
