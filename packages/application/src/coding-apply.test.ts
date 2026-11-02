import { expect, it } from 'vitest';
import type {
  CodingTask,
  Changeset,
  CodingTestEvidence,
  CodingReviewVerdict,
  CodingApplyReceipt,
} from '@runnets/domain';
import { CodingApplyService } from './coding-apply.js';
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

it.each(['success', 'failure', 'denied', 'dirty'])(
  'records per-file application %s and refuses replay',
  async (mode) => {
    const receipts = new Map<string, CodingApplyReceipt>(),
      effects: string[] = [];
    let claims = 0;
    const change = {
      before: null,
      after: { text: 'new', mode: '100644' as const, sha256: 'blob' },
    };
    const changeset = {
      ...artifact,
      files: [
        { ...change, path: 'one' },
        { ...change, path: 'two' },
      ],
    };
    const service = new CodingApplyService(
      {
        atomic: (work) =>
          work({
            task: () => configured,
            changeset: () => changeset,
            verdict: () => review,
            evidence: () => [evidence],
            application: (id) => receipts.get(id) ?? null,
            putApplication: (value) => {
              receipts.set(value.id, structuredClone(value));
            },
            claimApplication: () => {
              claims++;
              return true;
            },
          }),
      },
      {
        inspect: async () => ({ clean: mode !== 'dirty', baseCommit: artifact.baseCommit }),
        sourceTree: async () => artifact.afterTreeHash,
        applyFile: async (_root, file) => {
          expect(
            receipts.get('apply')?.files.find((entry) => entry.path === file.path)?.status,
          ).toBe('started');
          effects.push(file.path);
          if (mode === 'failure' && file.path === 'two') throw Error('interrupted');
        },
      },
      () => true,
    );
    const input = {
      id: 'apply',
      workspaceId: task.workspaceId,
      taskId: task.id,
      changesetHash: artifact.hash,
      reviewRequestId: 'review',
      expectedBase: artifact.baseCommit,
    };
    const result = await service.apply(input, { confirm: async () => mode !== 'denied' });
    if (mode === 'success') {
      expect(result.ok).toBe(true);
      expect(receipts.get('apply')?.status).toBe('completed');
    } else if (mode === 'failure') {
      expect(result.ok).toBe(false);
      expect(receipts.get('apply')).toMatchObject({
        status: 'uncertain',
        files: [
          { path: 'one', status: 'completed' },
          { path: 'two', status: 'uncertain' },
        ],
      });
    } else {
      expect(result.ok).toBe(false);
      expect(claims).toBe(0);
      expect(effects).toEqual([]);
    }
    if (mode === 'success' || mode === 'failure') {
      expect(claims).toBe(1);
      expect((await service.apply(input, { confirm: async () => true })).ok).toBe(false);
      expect(effects).toEqual(['one', 'two']);
    }
  },
);
