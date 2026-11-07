import { validConversationText } from '@runnets/domain';
import { bindingDigest, isLocalDecision, type LocalDecision } from './local-runtime-decisions.js';
import { localPosition } from './local-runtime-queries.js';
import { localRuntimeRecord } from './local-runtime.js';

export const CODING_APPLY_REQUEST = 'coding.changesets.apply';
export interface CodingApplyQuery {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly expectedBase: string;
  readonly changesetHash: string;
  readonly reviewRequestId: string;
}
export interface CodingApplySummary {
  readonly id: string;
  readonly taskId: string;
  readonly expectedBase: string;
  readonly changesetHash: string;
  readonly reviewRequestId: string;
  readonly status: 'applying' | 'completed' | 'uncertain' | 'not_started';
  readonly fileCount: number;
  readonly completedFiles: number;
  readonly uncertainFiles: number;
}
export interface CodingApplyStatus {
  readonly decision: LocalDecision;
  readonly state:
    | 'pending'
    | 'no_application'
    | 'unconfirmed'
    | 'applying'
    | 'completed'
    | 'outcome_unknown'
    | 'not_started';
  readonly receipt: CodingApplySummary | null;
}

const record = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  localRuntimeRecord(v) &&
  Reflect.ownKeys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === 'string' && validConversationText(v, 128);
const commit = (v: unknown) => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
const selection = ['taskId', 'expectedBase', 'changesetHash', 'reviewRequestId'] as const;
const exact = (v: Record<string, unknown>) =>
  id(v['taskId']) &&
  commit(v['expectedBase']) &&
  bindingDigest(v['changesetHash']) &&
  id(v['reviewRequestId']);

export function isCodingApplyQuery(v: unknown): v is CodingApplyQuery {
  return (
    record(v, ['workspaceId', 'roomId', 'requestId', ...selection]) &&
    id(v['workspaceId']) &&
    id(v['roomId']) &&
    id(v['requestId']) &&
    exact(v)
  );
}

function isCodingApplySummary(v: unknown): v is CodingApplySummary {
  if (
    !record(v, ['id', ...selection, 'status', 'fileCount', 'completedFiles', 'uncertainFiles']) ||
    !id(v['id']) ||
    !exact(v) ||
    !localPosition(v['fileCount']) ||
    v['fileCount'] > 2000 ||
    !localPosition(v['completedFiles']) ||
    !localPosition(v['uncertainFiles']) ||
    v['completedFiles'] + v['uncertainFiles'] > v['fileCount']
  )
    return false;
  if (v['status'] === 'uncertain') return true;
  if (v['uncertainFiles'] !== 0) return false;
  if (v['status'] === 'applying') return true;
  if (v['status'] === 'completed') return v['completedFiles'] === v['fileCount'];
  return v['status'] === 'not_started' && v['completedFiles'] === 0;
}

export function isCodingApplyStatus(v: unknown): v is CodingApplyStatus {
  if (
    !record(v, ['decision', 'state', 'receipt']) ||
    !isLocalDecision(v['decision']) ||
    v['decision'].kind !== 'project-setup'
  )
    return false;
  if (v['decision'].status === 'pending') return v['state'] === 'pending' && v['receipt'] === null;
  if (v['decision'].status !== 'allowed')
    return v['state'] === 'no_application' && v['receipt'] === null;
  if (v['receipt'] === null) return v['state'] === 'unconfirmed';
  if (!isCodingApplySummary(v['receipt']) || v['receipt'].id !== v['decision'].decisionId)
    return false;
  if (v['receipt'].status === 'uncertain') return v['state'] === 'outcome_unknown';
  return (
    v['state'] === v['receipt'].status ||
    (v['receipt'].status === 'applying' && v['state'] === 'outcome_unknown')
  );
}
