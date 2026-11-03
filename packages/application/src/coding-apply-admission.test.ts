import { expect, it } from 'vitest';
import type { CodingTask, CodingWorktree } from '@runnets/domain';
import { codingApplyAdmission } from './coding-apply-admission.js';
it('requires both current leases, room memberships and original non-restored owner authority', () => {
  const lease = {
    ownerId: 'owner',
    taskId: 'task',
    projectRoot: '/project',
    requestId: 'request',
    binding: 'binding',
    kind: 'coding' as const,
    token: 'project',
  };
  const task: CodingTask = {
    id: 'task',
    workspaceId: 'workspace',
    projectRoot: '/project',
    baseCommit: 'base',
    worktreeRoot: '/worktree',
    ownerRoomId: 'dev-room',
    devBotId: 'dev',
    reviewRoomId: 'review-room',
    reviewBotId: 'review',
    status: 'reserved',
    policyVersion: 1,
    policy: {
      version: 1,
      devCapabilities: ['project_read'],
      reviewCapabilities: ['changeset_read'],
      testPresets: [],
    },
    lease,
    createdAt: 'now',
  };
  const worktree: CodingWorktree = {
    taskId: 'task',
    workspaceId: 'workspace',
    projectRoot: '/project',
    root: '/worktree',
    branch: 'codex/task',
    baseCommit: 'base',
    gitCommonDir: '/project/.git',
    state: 'ready',
    lease: { ...lease, projectRoot: '/worktree', token: 'worktree' },
  };
  let member = true,
    ready = true,
    held = '',
    pending = false;
  const tx = { participates: () => member, worktree: () => (ready ? worktree : null) };
  const deps = {
    ownerId: 'owner',
    restored: false,
    leases: { owns: (value: typeof lease) => value.token !== held },
    journal: {
      inspectPending: () =>
        pending
          ? [
              {
                id: 'held',
                tool: 'write',
                taskRunId: 'run',
                attemptId: 'attempt',
                fingerprint: 'hash',
                outcome: 'started' as const,
              },
            ]
          : [],
    },
  };
  expect(codingApplyAdmission(task, tx, deps)).toBe(true);
  for (const token of ['project', 'worktree']) {
    held = token;
    expect(codingApplyAdmission(task, tx, deps)).toBe(false);
  }
  held = '';
  member = false;
  expect(codingApplyAdmission(task, tx, deps)).toBe(false);
  member = true;
  ready = false;
  expect(codingApplyAdmission(task, tx, deps)).toBe(false);
  ready = true;
  pending = true;
  expect(codingApplyAdmission(task, tx, deps)).toBe(false);
  pending = false;
  expect(codingApplyAdmission(task, tx, { ...deps, restored: true })).toBe(false);
  expect(codingApplyAdmission(task, tx, { ...deps, ownerId: 'other' })).toBe(false);
  expect(codingApplyAdmission({ ...task, status: 'cancelled' }, tx, deps)).toBe(false);
});
