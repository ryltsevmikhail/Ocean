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

it.each(['success', 'failure', 'denied', 'dirty', 'race', 'base-race', 'refactor'])(
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
        { ...change, path: mode === 'refactor' ? 'a' : 'one' },
        mode === 'refactor'
          ? { path: 'a/b', before: change.after, after: null }
          : { ...change, path: 'two' },
      ],
    };
    const service = new CodingApplyService(
      {
        atomic: (work) =>
          work({
            task: () => configured,
            worktree: () => null,
            participates: () => false,
            changeset: () => changeset,
            verdict: () => review,
            evidence: () => [evidence],
            application: (id) => receipts.get(id) ?? null,
            pendingApplications: () => [],
            putApplication: (value) => {
              receipts.set(value.id, structuredClone(value));
            },
            claimApplication: (receipt) => {
              expect(receipt.recoveryProtocol).toBe(2);
              claims++;
              return true;
            },
          }),
      },
      {
        inspect: async () => ({
          clean: mode !== 'dirty' && !(mode === 'base-race' && claims > 0),
          baseCommit: artifact.baseCommit,
        }),
        sourceTree: async () =>
          mode === 'race' && claims > 0 ? 'changed-after-claim' : artifact.afterTreeHash,
        applyFile: async (_root, file, context) => {
          expect(receipts.get('apply')?.recoveryProtocol).toBe(2);
          expect(context).toEqual({
            ownerId: task.lease.ownerId,
            taskId: task.id,
            applicationId: 'apply',
            changesetHash: artifact.hash,
          });
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
    if (mode === 'success' || mode === 'refactor') {
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
    } else if (mode === 'race' || mode === 'base-race') {
      expect(result.ok).toBe(false);
      expect(claims).toBe(1);
      expect(receipts.get('apply')?.status).toBe('not_started');
      expect(effects).toEqual([]);
    } else {
      expect(result.ok).toBe(false);
      expect(claims).toBe(0);
      expect(effects).toEqual([]);
    }
    if (mode === 'success' || mode === 'failure' || mode === 'refactor') {
      expect(claims).toBe(1);
      expect((await service.apply(input, { confirm: async () => true })).ok).toBe(false);
      expect(effects).toEqual(mode === 'refactor' ? ['a/b', 'a'] : ['one', 'two']);
    }
  },
);

it('refuses a concurrent second apply whose clean checkout observation preceded the first apply', async () => {
  const receipts = new Map<string, CodingApplyReceipt>();
  let clean = true,
    active = false,
    scans = 0,
    effects = 0;
  let release!: () => void, waiting!: () => void;
  const paused = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new CodingApplyService(
    {
      atomic: (work) =>
        work({
          task: () => configured,
          worktree: () => null,
          participates: () => false,
          changeset: () => ({
            ...artifact,
            files: [
              {
                path: 'file',
                before: null,
                after: { mode: '100644', text: 'new', sha256: 'hash' },
              },
            ],
          }),
          verdict: () => review,
          evidence: () => [evidence],
          application: (id) => receipts.get(id) ?? null,
          pendingApplications: () => [],
          claimApplication: (receipt) => {
            if (active) return false;
            active = true;
            receipts.set(receipt.id, receipt);
            return true;
          },
          putApplication: (receipt) => {
            receipts.set(receipt.id, structuredClone(receipt));
            if (receipt.status !== 'applying') active = false;
          },
        }),
    },
    {
      inspect: async () => ({ clean, baseCommit: artifact.baseCommit }),
      sourceTree: async () => {
        if (++scans === 2) {
          waiting();
          await resume;
        }
        return artifact.afterTreeHash;
      },
      applyFile: async () => {
        effects++;
        clean = false;
      },
    },
    () => true,
  );
  const input = {
    workspaceId: task.workspaceId,
    taskId: task.id,
    changesetHash: artifact.hash,
    reviewRequestId: 'review',
    expectedBase: artifact.baseCommit,
  };
  const second = service.apply({ ...input, id: 'second' }, { confirm: async () => true });
  await paused;
  expect((await service.apply({ ...input, id: 'first' }, { confirm: async () => true })).ok).toBe(
    true,
  );
  release();
  expect((await second).ok).toBe(false);
  expect(receipts.get('second')?.status).toBe('not_started');
  expect(effects).toBe(1);
});
