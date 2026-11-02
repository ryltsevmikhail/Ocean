import { expect, it, vi } from 'vitest';
import { assertCodingApplyTransition, type CodingApplyReceipt } from '@runnets/domain';
import { CodingApplyService } from './coding-apply.js';
it('holds interrupted per-file receipts without filesystem calls or dispatch and is idempotent', () => {
  let receipt: CodingApplyReceipt = {
    id: 'apply',
    taskId: 'task',
    changesetHash: 'hash',
    reviewRequestId: 'review',
    expectedBase: 'base',
    status: 'applying',
    files: [
      { path: 'a', status: 'completed' },
      { path: 'b', status: 'started' },
      { path: 'c', status: 'pending' },
    ],
  };
  const effect = vi.fn();
  const service = new CodingApplyService(
    {
      atomic: (work) =>
        work({
          task: () => null,
          worktree: () => null,
          participates: () => false,
          changeset: () => null,
          verdict: () => null,
          evidence: () => [],
          application: () => receipt,
          pendingApplications: () => (receipt.status === 'applying' ? [receipt] : []),
          putApplication: (value) => {
            assertCodingApplyTransition(receipt, value);
            receipt = value;
          },
          claimApplication: effect,
        }),
    },
    { inspect: effect, sourceTree: effect, applyFile: effect },
    () => false,
  );
  expect(service.recover()).toEqual([
    {
      ...receipt,
      status: 'uncertain',
      files: [
        { path: 'a', status: 'completed' },
        { path: 'b', status: 'uncertain' },
        { path: 'c', status: 'pending' },
      ],
    },
  ]);
  expect(receipt.status).toBe('uncertain');
  expect(effect).not.toHaveBeenCalled();
  expect(service.recover()).toEqual([]);
});
