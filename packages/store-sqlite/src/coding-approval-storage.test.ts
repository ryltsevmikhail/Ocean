import { afterEach, expect, it } from 'vitest';
import type { CodingApproval } from '@runnets/domain';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './schema.js';
import { SqliteCodingApprovalStore } from './coding-approval-storage.js';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function storeFixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  initializeSchema(db);
  return new SqliteCodingApprovalStore(db);
}
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
  const store = storeFixture();
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
  const store = storeFixture();
  store.atomic((tx) => tx.putApproval(pending));
  expect(() =>
    store.atomic((tx) => tx.putApproval({ ...pending, preview: 'changed', status: 'allowed' })),
  ).toThrow('immutable');
  store.atomic((tx) => tx.putApproval({ ...pending, status: 'allowed' }));
  expect(() => store.atomic((tx) => tx.putApproval({ ...pending, status: 'consumed' }))).toThrow(
    'missing',
  );
});

it('adds approval tables transactionally to schema 7', () => {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  initializeSchema(db);
  db.exec(
    "DROP TABLE ocean_coding_approval_claims; DROP TABLE ocean_coding_approvals; UPDATE meta SET value='7' WHERE key='schema_version'",
  );
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    '8',
  );
  expect(db.prepare('SELECT count(*) AS n FROM ocean_coding_approvals').get()?.['n']).toBe(0);
});
