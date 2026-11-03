import { expect, it, vi } from 'vitest';
import type {
  CodingApplyReceipt,
  CodingTask,
  Changeset,
  CodingApplyResolution,
} from '@runnets/domain';
import { CodingApplyResolutionService } from './coding-apply-resolution.js';
it.each([
  'accept',
  'deny',
  'stale',
  'other_effect',
  'wrong_tree',
  'revoked',
  'expired',
  'backward',
  'invalid_clock',
])(
  'owner reconciliation %s keeps uncertain history and never repeats project effects',
  async (mode) => {
    const receipt: CodingApplyReceipt = {
      id: 'apply',
      taskId: 'task',
      changesetHash: 'hash',
      reviewRequestId: 'review',
      expectedBase: 'base',
      status: 'uncertain',
      files: [{ path: 'file', status: 'uncertain' }],
    };
    const task = {
      id: 'task',
      workspaceId: 'workspace',
      baseCommit: 'base',
      projectRoot: '/project',
      lease: { ownerId: 'owner' },
    } as CodingTask;
    const changeset = {
      taskId: 'task',
      hash: 'hash',
      baseCommit: 'base',
      beforeTreeHash: 'before',
      afterTreeHash: 'after',
      files: [{ path: 'file' }],
    } as Changeset;
    let resolution: CodingApplyResolution | null = null,
      admitted = true,
      treeCalls = 0,
      elapsed = 0;
    const effect = {
      id: 'apply',
      taskRunId: 'apply-apply',
      attemptId: 'apply',
      tool: 'coding_apply',
      fingerprint: 'exact',
      outcome: 'uncertain' as const,
    };
    const put = vi.fn((value: CodingApplyResolution) => {
      resolution = value;
    });
    const service = new CodingApplyResolutionService(
      {
        atomic: (work) =>
          work({
            task: () => task,
            worktree: () => null,
            participates: () => true,
            application: () => receipt,
            changeset: () => changeset,
            unresolved: () =>
              mode === 'other_effect' ? [effect, { ...effect, id: 'other' }] : [effect],
            resolution: () => resolution,
            putResolution: put,
          }),
      },
      {
        tree: async () => {
          treeCalls++;
          return mode === 'wrong_tree' || (mode === 'stale' && treeCalls > 1) ? 'changed' : 'after';
        },
      },
      {
        ownerId: 'owner',
        clock: {
          now: () =>
            mode === 'invalid_clock'
              ? new Date(NaN)
              : new Date(Date.parse('2026-11-02T00:00:00Z') + elapsed),
        },
        admit: () => admitted,
      },
    );
    const owner = {
      confirm: vi.fn(async () => {
        if (mode === 'revoked') admitted = false;
        if (mode === 'expired') elapsed = 300000;
        if (mode === 'backward') elapsed = -1;
        return mode !== 'deny';
      }),
    };
    const input = {
      workspaceId: 'workspace',
      applicationId: 'apply',
      accepted: 'after' as const,
      reason: 'Inspected exact files',
    };
    const result = await service.reconcile(input, owner);
    expect(result.ok).toBe(mode === 'accept');
    expect(receipt.status).toBe('uncertain');
    if (mode === 'accept') {
      expect(put).toHaveBeenCalledOnce();
      expect(resolution).toMatchObject({
        applicationId: 'apply',
        accepted: 'after',
        treeHash: 'after',
        effectFingerprint: 'exact',
      });
      expect((await service.reconcile(input, owner)).ok).toBe(false);
      expect(put).toHaveBeenCalledOnce();
    } else expect(put).not.toHaveBeenCalled();
    if (['other_effect', 'wrong_tree', 'invalid_clock'].includes(mode))
      expect(owner.confirm).not.toHaveBeenCalled();
  },
);
