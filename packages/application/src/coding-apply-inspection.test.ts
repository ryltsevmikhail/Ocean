import { expect, it, vi } from 'vitest';
import type { CodingTask, Changeset, CodingApplyReceipt } from '@runnets/domain';
import type { CodingApplyStore } from './coding-apply.js';
import { CodingApplyInspectionService } from './coding-apply-inspection.js';
it('inspects exact owner-bound receipt while held without changing it, settling effects or dispatching writes', async () => {
  const receipt: CodingApplyReceipt = {
    id: 'apply',
    taskId: 'task',
    changesetHash: 'hash',
    reviewRequestId: 'review',
    expectedBase: 'base',
    status: 'uncertain',
    files: [{ path: 'file', status: 'uncertain' }],
  };
  const changeset: Changeset = {
    id: 'changeset',
    beforeTreeHash: 'before',
    afterTreeHash: 'after',
    diff: '-before\n+after',
    taskId: 'task',
    hash: 'hash',
    baseCommit: 'base',
    files: [
      {
        path: 'file',
        before: { sha256: 'before', mode: '100644', text: 'before' },
        after: { sha256: 'after', mode: '100644', text: 'after' },
      },
    ],
  };
  const task = {
    id: 'task',
    workspaceId: 'workspace',
    projectRoot: '/project',
    baseCommit: 'base',
  } as CodingTask;
  let admitted = true;
  const mutate = vi.fn(() => {
    throw Error('must not mutate');
  });
  const store: CodingApplyStore = {
    atomic: (work) =>
      work({
        task: () => task,
        changeset: () => changeset,
        application: () => receipt,
        pendingApplications: () => [],
        worktree: () => null,
        participates: () => true,
        evidence: () => [],
        verdict: () => null,
        putApplication: mutate,
        claimApplication: mutate,
      }),
  };
  const observe = vi.fn(async () => [
    { path: 'file', kind: 'file' as const, sha256: 'after', mode: '100644' as const },
  ]);
  const service = new CodingApplyInspectionService(store, { observe }, () => admitted);
  const input = { workspaceId: 'workspace', applicationId: 'apply' };
  expect(await service.inspect(input)).toMatchObject({
    ok: true,
    value: { receipt, holdReleased: false, files: [{ path: 'file', comparison: 'after' }] },
  });
  expect(mutate).not.toHaveBeenCalled();
  admitted = false;
  expect((await service.inspect(input)).ok).toBe(false);
  expect(observe).toHaveBeenCalledOnce();
  admitted = true;
  observe.mockImplementationOnce(async () => {
    admitted = false;
    return [{ path: 'file', kind: 'file', sha256: 'after', mode: '100644' }];
  });
  expect((await service.inspect(input)).ok).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
});
