import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  validOwnerGrantReference,
  codingApprovalMatches,
  validCodingApprovalBinding,
  type CodingApproval,
  type CodingApprovalBinding,
  type CodingTask,
  type CodingTestEvidence,
} from '@runnets/domain';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: object, required: string[], optional: string[] = []): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
const bindingKeys = [
  'workspaceId',
  'taskId',
  'projectRoot',
  'worktreeRoot',
  'roomId',
  'botId',
  'runId',
  'attemptId',
  'invocationId',
  'operation',
  'operationHash',
  'sourceTreeHash',
  'policyVersion',
  'limitsHash',
  'toolchainHash',
];
function validBinding(value: unknown): value is CodingApprovalBinding {
  return (
    record(value) &&
    keys(value, bindingKeys) &&
    validCodingApprovalBinding(value as unknown as CodingApprovalBinding) &&
    ['operationHash', 'sourceTreeHash', 'limitsHash', 'toolchainHash'].every((k) => hex(value[k]))
  );
}
export function approvalOf(payload: unknown): CodingApproval | null {
  if (typeof payload !== 'string') return null;
  const a: unknown = JSON.parse(payload);
  if (
    !record(a) ||
    !keys(
      a,
      ['id', 'binding', 'preview', 'createdAt', 'expiresAt', 'status'],
      ['authorityId', 'grantReference', 'guardedDispatch'],
    ) ||
    (Object.hasOwn(a, 'guardedDispatch') && a['guardedDispatch'] !== true) ||
    (Object.hasOwn(a, 'grantReference') && !validOwnerGrantReference(a['grantReference'])) ||
    typeof a['id'] !== 'string' ||
    !a['id'] ||
    !validBinding(a['binding']) ||
    typeof a['preview'] !== 'string' ||
    !a['preview'] ||
    a['preview'].length > 1048576 ||
    !Number.isSafeInteger(a['createdAt']) ||
    !Number.isSafeInteger(a['expiresAt']) ||
    Number(a['expiresAt']) <= Number(a['createdAt']) ||
    Number(a['expiresAt']) - Number(a['createdAt']) > 300000 ||
    !['pending', 'allowed', 'denied', 'consumed'].includes(String(a['status'])) ||
    (Object.hasOwn(a, 'authorityId') && (typeof a['authorityId'] !== 'string' || !a['authorityId']))
  )
    return null;
  return a as unknown as CodingApproval;
}
/** The result is durable before journal settlement; never compare it to today's tree. */
export function testClaimQuiescent(
  db: DatabaseSync,
  approval: CodingApproval,
  task: CodingTask,
  outcome: unknown,
): boolean {
  const row = db.prepare('SELECT * FROM ocean_coding_test_evidence WHERE id=?').get(approval.id);
  if (!row || typeof row['payload'] !== 'string') return false;
  const value: unknown = JSON.parse(row['payload']);
  if (
    !record(value) ||
    !keys(value, [
      'presetId',
      'id',
      'hash',
      'binding',
      'invocationHash',
      'beforeTreeHash',
      'afterTreeHash',
      'dependencyHash',
      'dependenciesUnchanged',
      'exitCode',
      'reason',
      'cleanupConfirmed',
      'truncated',
      'output',
    ]) ||
    !validBinding(value['binding'])
  )
    return false;
  const e = value as unknown as CodingTestEvidence;
  const { hash, ...body } = e;
  const preset = task.policy.testPresets.find((p) => p.id === e.presetId);
  if (
    e.id !== approval.id ||
    row['task_id'] !== task.id ||
    row['hash'] !== hash ||
    !hex(hash) ||
    hash !== digest(JSON.stringify(body)) ||
    !codingApprovalMatches(
      approval.binding,
      e.binding,
      approval.createdAt,
      approval.expiresAt,
      approval.createdAt,
    ) ||
    !['invocationHash', 'beforeTreeHash', 'afterTreeHash', 'dependencyHash'].every((k) =>
      hex(value[k]),
    ) ||
    e.beforeTreeHash !== approval.binding.sourceTreeHash ||
    e.cleanupConfirmed !== true ||
    typeof e.dependenciesUnchanged !== 'boolean' ||
    typeof e.truncated !== 'boolean' ||
    typeof e.output !== 'string' ||
    !['exit', 'timeout', 'cancelled', 'unavailable'].includes(e.reason) ||
    (e.exitCode !== null &&
      (!Number.isSafeInteger(e.exitCode) || e.exitCode < 0 || e.exitCode > 255)) ||
    !preset ||
    approval.preview.split('\n')[0] !==
      JSON.stringify({ program: preset.program, args: preset.args, cwd: preset.cwd })
  )
    return false;
  // Match SandboxBackend.command's result, not codingTestPassed (truncation is not liveness).
  const succeeded =
    e.exitCode === 0 &&
    e.reason === 'exit' &&
    e.beforeTreeHash === e.afterTreeHash &&
    e.dependenciesUnchanged;
  return outcome === (succeeded ? 'completed' : 'failed');
}
