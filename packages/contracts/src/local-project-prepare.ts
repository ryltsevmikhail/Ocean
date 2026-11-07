import { validConversationText } from '@runnets/domain';
import { localRuntimeRecord } from './local-runtime.js';
import { isLocalDecision, type LocalDecision } from './local-runtime-decisions.js';
export interface CodingTaskPrepare {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly expectedPolicyVersion: number;
}
export interface PreparedCodingWorktree {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly root: string;
  readonly branch: string;
  readonly gitCommonDir: string;
  readonly state: 'ready';
}
export interface CodingTaskPreparation {
  readonly decision: LocalDecision | null;
  readonly status: LocalDecision['status'] | 'prepared' | 'existing' | 'unconfirmed';
  readonly worktree: PreparedCodingWorktree | null;
}
export function isCodingTaskPrepare(v: unknown): v is CodingTaskPrepare {
  return (
    localRuntimeRecord(v) &&
    Reflect.ownKeys(v).length === 5 &&
    ['workspaceId', 'roomId', 'taskId', 'requestId'].every(
      (k) => Object.hasOwn(v, k) && typeof v[k] === 'string' && validConversationText(v[k], 128),
    ) &&
    Object.hasOwn(v, 'expectedPolicyVersion') &&
    Number.isSafeInteger(v['expectedPolicyVersion']) &&
    Number(v['expectedPolicyVersion']) > 0
  );
}
function ready(v: unknown): v is PreparedCodingWorktree {
  return (
    localRuntimeRecord(v) &&
    Reflect.ownKeys(v).length === 8 &&
    Object.hasOwn(v, 'state') &&
    v['state'] === 'ready' &&
    ['workspaceId', 'taskId', 'projectRoot', 'baseCommit', 'root', 'branch', 'gitCommonDir'].every(
      (k) => Object.hasOwn(v, k) && typeof v[k] === 'string' && validConversationText(v[k], 4096),
    )
  );
}
export function isCodingTaskPreparation(v: unknown): v is CodingTaskPreparation {
  if (
    !localRuntimeRecord(v) ||
    Reflect.ownKeys(v).length !== 3 ||
    !['status', 'decision', 'worktree'].every((k) => Object.hasOwn(v, k))
  )
    return false;
  if (v['status'] === 'existing') return v['decision'] === null && ready(v['worktree']);
  if (!isLocalDecision(v['decision']) || v['decision'].kind !== 'project-setup') return false;
  return v['status'] === 'prepared'
    ? v['decision'].status === 'allowed' && ready(v['worktree'])
    : v['worktree'] === null &&
        (v['status'] === v['decision'].status ||
          (v['status'] === 'unconfirmed' && v['decision'].status === 'allowed'));
}
