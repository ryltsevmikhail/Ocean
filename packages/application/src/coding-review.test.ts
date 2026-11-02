import { expect, it } from 'vitest';
import type {
  CodingTask,
  Changeset,
  CodingReviewRequest,
  CodingReviewVerdict,
} from '@runnets/domain';
import { CodingReviewService } from './coding-review.js';
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

it('hands off only the frozen artifact and explicit context then rejects stale evidence', async () => {
  const changeset: Changeset = {
    id: 'c',
    hash: 'hash',
    taskId: task.id,
    baseCommit: 'base',
    beforeTreeHash: 'before',
    afterTreeHash: 'after',
    diff: 'seeded defect',
    files: [
      {
        path: 'source.ts',
        before: null,
        after: { mode: '100644', text: 'defect', sha256: 'blob' },
      },
    ],
  };
  let request: CodingReviewRequest | null = null,
    evidence = ['test'];
  const verdicts: CodingReviewVerdict[] = [];
  const service = new CodingReviewService(
    {
      atomic: (work) =>
        work({
          task: () => task,
          changeset: () => changeset,
          reviewRequest: () => request,
          putReviewRequest: (value) => {
            request = structuredClone(value);
          },
          reviewVerdict: () => null,
          putReviewVerdict: (_requestId, value) => {
            verdicts.push(structuredClone(value));
          },
          evidence: () => [],
          evidenceHashes: () => evidence,
        }),
    },
    () => true,
  );
  const result = await service.request(
    { id: 'request', workspaceId: task.workspaceId, taskId: task.id, changesetHash: 'hash' },
    {
      confirm: async (preview) => {
        expect(preview.changeset.diff).toBe('seeded defect');
        expect(preview.request.contextGrant).toEqual([]);
        expect(Object.keys(preview)).toEqual(['request', 'changeset']);
        return true;
      },
    },
  );
  if (!result.ok) throw Error('request');
  const verdict: CodingReviewVerdict = {
    id: 'verdict',
    binding: result.value.binding,
    reviewerBotId: task.reviewBotId,
    reviewRoomId: task.reviewRoomId,
    verdict: 'changes_requested',
    summary: 'Fix defect',
    findings: [
      {
        path: 'source.ts',
        side: 'after',
        line: 1,
        severity: 'important',
        explanation: 'seeded defect',
      },
    ],
  };
  evidence = ['new test'];
  expect(service.record('request', verdict).ok).toBe(false);
  expect(verdicts).toEqual([]);
  evidence = ['test'];
  expect(service.record('request', verdict).ok).toBe(true);
  expect(service.record('request', verdict).ok).toBe(false);
  expect(verdicts).toEqual([verdict]);
});

it.each(['success', 'failure'])(
  'records reviewer %s dispatch before external invocation and refuses replay',
  async (mode) => {
    const artifact: Changeset = {
      id: 'c',
      hash: 'hash',
      taskId: task.id,
      baseCommit: 'base',
      beforeTreeHash: 'before',
      afterTreeHash: 'after',
      files: [],
      diff: 'complete',
    };
    let request: CodingReviewRequest | null = null;
    const service = new CodingReviewService(
      {
        atomic: (work) =>
          work({
            task: () => task,
            changeset: () => artifact,
            reviewRequest: () => request,
            reviewVerdict: () => null,
            putReviewRequest: (value) => {
              request = structuredClone(value);
            },
            putReviewVerdict: () => {},
            evidenceHashes: () => [],
            evidence: () => [],
          }),
      },
      () => true,
    );
    await service.request(
      { id: 'review', workspaceId: task.workspaceId, taskId: task.id, changesetHash: 'hash' },
      { confirm: async () => true },
    );
    let calls = 0;
    const reviewer = {
      review: async (input: { request: CodingReviewRequest; changeset: Changeset }) => {
        calls++;
        expect(request?.status).toBe('dispatching');
        expect(input.request.contextGrant).toEqual([]);
        expect(input.changeset).toEqual(artifact);
        if (mode === 'failure') throw Error('unknown provider outcome');
        return { verdict: 'insufficient_context' as const, findings: [], summary: 'No tests' };
      },
    };
    expect((await service.dispatch('review', reviewer)).ok).toBe(mode === 'success');
    expect((await service.dispatch('review', reviewer)).ok).toBe(false);
    expect(calls).toBe(1);
  },
);
