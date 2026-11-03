import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingApprovalBinding, CodingTestEvidence } from '@runnets/domain';
import { openSqliteStore } from './index.js';
const binding: CodingApprovalBinding = {
  workspaceId: 'workspace',
  taskId: 'task',
  projectRoot: '/project',
  worktreeRoot: '/task',
  roomId: 'room',
  botId: 'dev',
  runId: 'run',
  attemptId: 'attempt',
  invocationId: 'call',
  operation: 'write',
  operationHash: 'exact-patch',
  sourceTreeHash: 'tree',
  policyVersion: 1,
  limitsHash: 'limits',
  toolchainHash: 'toolchain',
};

const evidence: CodingTestEvidence = {
  id: 'test',
  hash: 'hash',
  binding: { ...binding, operation: 'test' },
  invocationHash: 'invocation',
  beforeTreeHash: 'tree',
  afterTreeHash: 'tree',
  dependencyHash: 'deps',
  dependenciesUnchanged: true,
  exitCode: 0,
  reason: 'exit',
  cleanupConfirmed: true,
  truncated: false,
  output: 'passed',
};

it('keeps exact immutable evidence after closing and reopening the public store', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-evidence-store-')),
    path = join(root, 'fixture.sqlite');
  try {
    const store = openSqliteStore({ path });
    try {
      store.codingEvidence.put(evidence);
      expect(() => store.codingEvidence.put({ ...evidence, output: 'replacement' })).toThrow();
    } finally {
      store.close();
    }
    const reopened = openSqliteStore({ path });
    try {
      expect(reopened.codingEvidence.list(evidence.binding.taskId)).toEqual([evidence]);
      expect(reopened.codingEvidence.list('other-task')).toEqual([]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
