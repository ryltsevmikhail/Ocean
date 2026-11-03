import { expect, it } from 'vitest';
import type { CodingTask } from './coding-task.js';
import type { Changeset } from './changeset.js';
import type { CodingTestEvidence } from './coding-test-evidence.js';
import type { CodingReviewVerdict } from './coding-review.js';
import { codingApplicationVerified } from './coding-apply.js';
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

const configured = {
  ...task,
  worktreeRoot: '/wt',
  policy: {
    ...task.policy,
    testPresets: [{ id: 'test', program: '/node', args: [], cwd: '.' as const }],
  },
};
const artifact: Changeset = {
  id: 'c',
  hash: 'hash',
  taskId: task.id,
  baseCommit: task.baseCommit,
  beforeTreeHash: 'before',
  afterTreeHash: 'after',
  files: [],
  diff: 'complete',
};
const evidence: CodingTestEvidence = {
  id: 'test',
  hash: 'evidence',
  presetId: 'test',
  binding: {
    workspaceId: task.workspaceId,
    taskId: task.id,
    projectRoot: task.projectRoot,
    worktreeRoot: '/wt',
    roomId: task.ownerRoomId,
    botId: task.devBotId,
    runId: 'run',
    attemptId: 'attempt',
    invocationId: 'call',
    operation: 'test',
    operationHash: 'operation',
    sourceTreeHash: 'after',
    policyVersion: 1,
    limitsHash: 'limits',
    toolchainHash: 'tools',
  },
  invocationHash: 'invocation',
  beforeTreeHash: 'after',
  afterTreeHash: 'after',
  dependencyHash: 'deps',
  dependenciesUnchanged: true,
  exitCode: 0,
  reason: 'exit',
  cleanupConfirmed: true,
  truncated: false,
  output: 'passed',
};
const review: CodingReviewVerdict = {
  id: 'review',
  reviewerBotId: task.reviewBotId,
  reviewRoomId: task.reviewRoomId,
  verdict: 'approve',
  findings: [],
  summary: 'Approved',
  binding: {
    taskId: task.id,
    changesetHash: 'hash',
    baseCommit: task.baseCommit,
    afterTreeHash: 'after',
    testEvidenceHashes: ['evidence'],
  },
};
it('requires every registered preset on the exact reviewed source', () => {
  expect(codingApplicationVerified(configured, artifact, review, [evidence])).toBe(true);
  expect(codingApplicationVerified(configured, artifact, review, [])).toBe(false);
  expect(codingApplicationVerified(task, artifact, review, [evidence])).toBe(false);
  expect(
    codingApplicationVerified(
      {
        ...configured,
        policy: {
          ...configured.policy,
          testPresets: [
            ...configured.policy.testPresets,
            { id: 'lint', program: '/lint', args: [], cwd: '.' },
          ],
        },
      },
      artifact,
      review,
      [evidence],
    ),
  ).toBe(false);
});
it.each([
  { truncated: true },
  { cleanupConfirmed: false },
  { afterTreeHash: 'new' },
  { exitCode: 1 },
  { presetId: 'unknown' },
])('refuses advisory approval backed by incomplete evidence %j', (patch) => {
  expect(codingApplicationVerified(configured, artifact, review, [{ ...evidence, ...patch }])).toBe(
    false,
  );
});
