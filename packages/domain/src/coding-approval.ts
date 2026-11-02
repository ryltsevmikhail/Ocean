/** Runtime-created binding. Hashes refer to complete immutable operation previews. */
export interface CodingApprovalBinding {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly projectRoot: string;
  readonly worktreeRoot: string;
  readonly roomId: string;
  readonly botId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly operation: 'write' | 'test' | 'apply';
  readonly operationHash: string;
  readonly sourceTreeHash: string;
  readonly policyVersion: number;
  readonly limitsHash: string;
  readonly toolchainHash: string;
}
export interface CodingApproval {
  readonly id: string;
  readonly binding: CodingApprovalBinding;
  readonly preview: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: 'pending' | 'allowed' | 'denied' | 'consumed';
}
const keys = [
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
] as const;
export function validCodingApprovalBinding(binding: CodingApprovalBinding): boolean {
  return (
    Number.isSafeInteger(binding.policyVersion) &&
    binding.policyVersion > 0 &&
    ['write', 'test', 'apply'].includes(binding.operation) &&
    keys.every(
      (key) =>
        key === 'policyVersion' ||
        (typeof binding[key] === 'string' &&
          binding[key].length > 0 &&
          binding[key].length <= 4096 &&
          !binding[key].includes('\0')),
    )
  );
}
/** A decision expires at its deadline and cannot survive a backwards clock. */
export function codingApprovalMatches(
  approved: CodingApprovalBinding,
  current: CodingApprovalBinding,
  createdAt: number,
  expiresAt: number,
  now: number,
): boolean {
  return (
    validCodingApprovalBinding(approved) &&
    validCodingApprovalBinding(current) &&
    [createdAt, expiresAt, now].every(Number.isSafeInteger) &&
    expiresAt > createdAt &&
    expiresAt - createdAt <= 300000 &&
    now >= createdAt &&
    now < expiresAt &&
    keys.every((key) => approved[key] === current[key])
  );
}
