import type { OwnerGrantReference, OwnerScopeGrant } from './owner-scope-grant.js';
export interface CodingGrantDebit {
  readonly chargedRunId: string;
  readonly subject: OwnerScopeGrant['subject'];
  readonly grantId: string;
  readonly revision: number;
}
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
  readonly authorityId?: string;
  /** Only the guarded host can prove zero worker dispatch at settlement. */
  readonly guardedDispatch?: true;
  readonly grantReference?: OwnerGrantReference;
  readonly roomBasis?: readonly CodingGrantDebit[];
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

/** Stored basis is exact bounded evidence; coercible scalars and duplicate debits refuse. */
export function validCodingGrantBasis(value: unknown): value is readonly CodingGrantDebit[] {
  const text = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= 128 && !v.includes('\0');
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 1024 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return false;
  const seen = new Set<string>();
  return value.every((d: unknown) => {
    if (
      !object(d) ||
      Reflect.ownKeys(d).some((k) => typeof k !== 'string') ||
      Object.keys(d).sort().join() !== 'chargedRunId,grantId,revision,subject' ||
      !text(d['chargedRunId']) ||
      !text(d['grantId']) ||
      typeof d['revision'] !== 'number' ||
      !Number.isSafeInteger(d['revision']) ||
      d['revision'] < 1 ||
      !object(d['subject'])
    )
      return false;
    const subject = d['subject'];
    if (
      Reflect.ownKeys(subject).some((k) => typeof k !== 'string') ||
      Object.keys(subject).sort().join() !== 'botId,projectId,roomId,taskId,workspaceId' ||
      !['workspaceId', 'roomId', 'botId'].every((k) => text(subject[k])) ||
      !['projectId', 'taskId'].every((k) => subject[k] === null || text(subject[k]))
    )
      return false;
    const key = JSON.stringify([
      d['chargedRunId'],
      ...['workspaceId', 'roomId', 'botId', 'projectId', 'taskId'].map((k) => subject[k]),
      d['grantId'],
      d['revision'],
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
