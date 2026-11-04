import { SqliteToolJournal } from './tool-journal.js';
import { afterEach, expect, it } from 'vitest';
import type { CodingApproval } from '@runnets/domain';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, initializeSchema } from './schema.js';
import { SqliteCodingApprovalStore } from './coding-approval-storage.js';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
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
    "DROP TABLE ocean_desktop_operations; DROP TABLE ocean_desktop_uploads; DROP TABLE ocean_desktop_adopted; DROP TABLE ocean_owner_decisions; DROP TABLE ocean_coding_applications; DROP TABLE ocean_coding_review_verdicts; DROP TABLE ocean_coding_review_requests; DROP TABLE ocean_coding_test_evidence; DROP TABLE ocean_coding_approval_claims; DROP TABLE ocean_coding_approvals; DROP TABLE ocean_profile_rebinds; DROP TABLE ocean_rebind_observations; DROP TABLE ocean_execution_epoch; DROP TABLE ocean_restore_origins; DROP TABLE ocean_restore_origin; DROP TABLE ocean_retired_epochs; UPDATE meta SET value='7' WHERE key='schema_version'",
  );
  initializeSchema(db);
  expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value']).toBe(
    String(SCHEMA_VERSION),
  );
  expect(db.prepare('SELECT count(*) AS n FROM ocean_coding_approvals').get()?.['n']).toBe(0);
});

it('preserves consumed status and invocation uniqueness across connections and reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-approval-db-'));
  try {
    const path = join(root, 'fixture.sqlite');
    const first = new DatabaseSync(path);
    databases.push(first);
    initializeSchema(first);
    const a = new SqliteCodingApprovalStore(first);
    a.atomic((tx) => tx.putApproval(pending));
    const allowed = { ...pending, status: 'allowed' } as const;
    a.atomic((tx) => tx.putApproval(allowed));
    const second = new DatabaseSync(path);
    databases.push(second);
    initializeSchema(second);
    const b = new SqliteCodingApprovalStore(second);
    expect(b.atomic((tx) => tx.approval(pending.id)?.status)).toBe('allowed');
    a.atomic((tx) => {
      expect(tx.claimApprovalOperation(allowed)).toBe(true);
      tx.putApproval({ ...allowed, status: 'consumed' });
    });
    expect(b.atomic((tx) => tx.claimApprovalOperation(allowed))).toBe(false);
    first.close();
    second.close();
    const reopened = new DatabaseSync(path);
    databases.push(reopened);
    initializeSchema(reopened);
    const restored = new SqliteCodingApprovalStore(reopened);
    expect(restored.atomic((tx) => tx.approval(pending.id)?.status)).toBe('consumed');
    expect(restored.atomic((tx) => tx.claimApprovalOperation(allowed))).toBe(false);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('requires the dispatch claim to belong to the consumed approval', () => {
  const store = storeFixture();
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

it('publishes approval consumption and the shared unresolved effect atomically', async () => {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  initializeSchema(db);
  const store = new SqliteCodingApprovalStore(db),
    journal = new SqliteToolJournal(db);
  const allowed = { ...pending, status: 'allowed' } as const;
  store.atomic((tx) => tx.putApproval(pending));
  store.atomic((tx) => tx.putApproval(allowed));
  expect(() =>
    store.atomic((tx) => {
      expect(tx.claimApprovalOperation(allowed)).toBe(true);
      tx.putApproval({ ...allowed, status: 'consumed' });
      throw Error('crash');
    }),
  ).toThrow('crash');
  expect(journal.inspectPending()).toEqual([]);
  store.atomic((tx) => {
    expect(tx.claimApprovalOperation(allowed)).toBe(true);
    tx.putApproval({ ...allowed, status: 'consumed' });
  });
  expect(journal.inspectPending()).toMatchObject([
    { id: 'i', taskRunId: 'run', attemptId: 'a', tool: 'coding_write', outcome: 'started' },
  ]);
  expect(
    await journal.claim(
      'other',
      'legacy',
      { taskRunId: 'other', attemptId: 'other' },
      'fingerprint',
    ),
  ).toBe(false);
});
