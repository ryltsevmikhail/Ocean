import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteStore } from './index.js';
import type { CodingApproval } from '@runnets/domain';
it('opens durable approval storage through the public store factory', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-approval-factory-'));
  const path = join(root, 'fixture.sqlite');
  const approval: CodingApproval = {
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
  try {
    const store = openSqliteStore({ path });
    try {
      store.codingApprovals.atomic((tx) => tx.putApproval(approval));
    } finally {
      store.close();
    }
    const reopened = openSqliteStore({ path });
    try {
      expect(reopened.codingApprovals.atomic((tx) => tx.approval(approval.id))).toEqual(approval);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
