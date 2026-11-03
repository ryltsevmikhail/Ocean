import { expect, it } from 'vitest';
import type { CodingApprovalBinding } from './coding-approval.js';
import { codingTestPassed, type CodingTestEvidence } from './coding-test-evidence.js';
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
it('accepts only evidence tied to the approved source snapshot', () => {
  expect(codingTestPassed(evidence)).toBe(true);
  expect(
    codingTestPassed({ ...evidence, binding: { ...evidence.binding, sourceTreeHash: 'other' } }),
  ).toBe(false);
});
it.each([
  { exitCode: 1 },
  { cleanupConfirmed: false },
  { truncated: true },
  { dependenciesUnchanged: false },
  { beforeTreeHash: 'changed' },
  { afterTreeHash: 'changed' },
  { reason: 'timeout' as const },
])('refuses incomplete or stale passed evidence %j', (patch) => {
  expect(codingTestPassed({ ...evidence, ...patch })).toBe(false);
});
