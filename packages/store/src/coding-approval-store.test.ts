import { expect, it } from 'vitest';
import type { CodingApproval } from '@runnets/domain';
import { InMemoryCodingApprovalStore } from './coding-approval-store.js';
const pending: CodingApproval = {
  id: 'approval',
  preview: 'patch',
  createdAt: 100,
  expiresAt: 300100,
  status: 'pending',
  binding: {
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
  },
};
it('rolls claim and approval back together and preserves one-shot consumption', () => {
  const store = new InMemoryCodingApprovalStore();
  store.atomic((tx) => tx.putApproval(pending));
  const allowed = { ...pending, status: 'allowed' } as const;
  store.atomic((tx) => tx.putApproval(allowed));
  expect(() =>
    store.atomic((tx) => {
      expect(tx.claimApprovalOperation(allowed)).toBe(true);
      tx.putApproval({ ...allowed, status: 'consumed' });
      throw Error('crash');
    }),
  ).toThrow('crash');
  expect(store.atomic((tx) => tx.approval(pending.id)?.status)).toBe('allowed');
  store.atomic((tx) => {
    expect(tx.claimApprovalOperation(allowed)).toBe(true);
    tx.putApproval({ ...allowed, status: 'consumed' });
  });
  expect(store.atomic((tx) => tx.claimApprovalOperation(allowed))).toBe(false);
  expect(() => store.atomic((tx) => tx.putApproval(allowed))).toThrow('transition');
});
it('refuses preview mutation and consumption without a claim', () => {
  const store = new InMemoryCodingApprovalStore();
  store.atomic((tx) => tx.putApproval(pending));
  expect(() =>
    store.atomic((tx) => tx.putApproval({ ...pending, preview: 'changed', status: 'allowed' })),
  ).toThrow('immutable');
  store.atomic((tx) => tx.putApproval({ ...pending, status: 'allowed' }));
  expect(() => store.atomic((tx) => tx.putApproval({ ...pending, status: 'consumed' }))).toThrow(
    'missing',
  );
});

it('requires the dispatch claim to belong to the consumed approval', () => {
  const store = new InMemoryCodingApprovalStore();
  store.atomic((tx) => tx.putApproval(pending));
  const allowed = { ...pending, status: 'allowed' } as const;
  store.atomic((tx) => tx.putApproval(allowed));
  store.atomic((tx) => {
    tx.claimApprovalOperation(allowed);
    tx.putApproval({ ...allowed, status: 'consumed' });
  });
  const other = { ...pending, id: 'other' };
  store.atomic((tx) => tx.putApproval(other));
  store.atomic((tx) => tx.putApproval({ ...other, status: 'allowed' }));
  expect(() => store.atomic((tx) => tx.putApproval({ ...other, status: 'consumed' }))).toThrow(
    'missing',
  );
});
