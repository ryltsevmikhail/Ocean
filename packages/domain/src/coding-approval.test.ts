import { expect, it } from 'vitest';
import { codingApprovalMatches, type CodingApprovalBinding } from './coding-approval.js';

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
it('accepts only an unexpired exact binding', () => {
  expect(codingApprovalMatches(binding, binding, 100, 300100, 101)).toBe(true);
  expect(codingApprovalMatches(binding, binding, 100, 300100, 300100)).toBe(false);
  expect(codingApprovalMatches(binding, binding, 100, 300101, 101)).toBe(false);
  expect(codingApprovalMatches(binding, binding, 100, 300100, 99)).toBe(false);
  expect(codingApprovalMatches(binding, binding, 100, 300100, NaN)).toBe(false);
});
it.each(Object.keys(binding) as (keyof CodingApprovalBinding)[])('refuses changed %s', (key) => {
  const changed = { ...binding, [key]: key === 'policyVersion' ? 2 : 'different' };
  expect(codingApprovalMatches(binding, changed, 100, 300100, 101)).toBe(false);
});

it.each([{ runId: '' }, { attemptId: 'bad\0value' }, { policyVersion: NaN }, { policyVersion: 0 }])(
  'refuses malformed binding even when both copies match %j',
  (patch) => {
    const invalid = { ...binding, ...patch };
    expect(codingApprovalMatches(invalid, invalid, 100, 300100, 101)).toBe(false);
  },
);
