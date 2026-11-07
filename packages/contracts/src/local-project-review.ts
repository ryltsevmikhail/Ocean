import { validConversationText, type CodingReviewVerdict } from '@runnets/domain';
import { bindingDigest, isLocalDecision, type LocalDecision } from './local-runtime-decisions.js';
import { LOCAL_RUNTIME_MAX_FRAME, localRuntimeRecord } from './local-runtime.js';

export interface CodingReviewQuery {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly hash: string;
}
export const CODING_REVIEW_REQUEST = 'coding.reviews.request';
export type CodingReviewState =
  | 'pending'
  | 'no_review'
  | 'unconfirmed'
  | 'requested'
  | 'dispatching'
  | 'outcome_unknown'
  | 'completed';
export type CodingReviewTests = 'none' | 'matches_snapshot' | 'different_snapshot' | 'changed';
export interface CodingReviewStatus {
  readonly decision: LocalDecision;
  readonly state: CodingReviewState;
  /** Stored snapshot, test evidence and task scope; no live Git scan. */
  readonly stale: boolean;
  readonly tests: CodingReviewTests;
  readonly verdict: CodingReviewVerdict | null;
}

function record(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return (
    localRuntimeRecord(v) &&
    Reflect.ownKeys(v).length === keys.length &&
    keys.every((key) => Object.hasOwn(v, key))
  );
}
const text = (v: unknown, max: number) => typeof v === 'string' && validConversationText(v, max);
const content = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function isCodingReviewQuery(v: unknown): v is CodingReviewQuery {
  return (
    record(v, ['workspaceId', 'roomId', 'taskId', 'requestId', 'hash']) &&
    ['workspaceId', 'roomId', 'taskId', 'requestId'].every((k) => text(v[k], 128)) &&
    bindingDigest(v['hash'])
  );
}
function verdict(v: unknown): v is CodingReviewVerdict {
  if (
    !record(v, ['id', 'binding', 'reviewerBotId', 'reviewRoomId', 'verdict', 'summary', 'findings'])
  )
    return false;
  const b = v['binding'];
  return (
    ['id', 'reviewerBotId', 'reviewRoomId'].every((k) => text(v[k], 128)) &&
    ['approve', 'changes_requested', 'insufficient_context'].some((x) => x === v['verdict']) &&
    content(v['summary'], 131072) &&
    record(b, ['taskId', 'changesetHash', 'baseCommit', 'afterTreeHash', 'testEvidenceHashes']) &&
    text(b['taskId'], 128) &&
    bindingDigest(b['changesetHash']) &&
    typeof b['baseCommit'] === 'string' &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(b['baseCommit']) &&
    bindingDigest(b['afterTreeHash']) &&
    Array.isArray(b['testEvidenceHashes']) &&
    b['testEvidenceHashes'].length <= 1024 &&
    b['testEvidenceHashes'].every(bindingDigest) &&
    Array.isArray(v['findings']) &&
    v['findings'].length <= 100 &&
    v['findings'].every(
      (f) =>
        record(f, ['path', 'side', 'line', 'severity', 'explanation']) &&
        text(f['path'], 4096) &&
        (f['side'] === 'before' || f['side'] === 'after') &&
        Number.isSafeInteger(f['line']) &&
        Number(f['line']) > 0 &&
        ['critical', 'important', 'minor'].some((x) => x === f['severity']) &&
        content(f['explanation'], 16384),
    )
  );
}
export function isCodingReviewStatus(v: unknown): v is CodingReviewStatus {
  if (
    !record(v, ['decision', 'state', 'stale', 'tests', 'verdict']) ||
    !isLocalDecision(v['decision']) ||
    v['decision'].kind !== 'project-setup' ||
    typeof v['stale'] !== 'boolean' ||
    !['none', 'matches_snapshot', 'different_snapshot', 'changed'].some((x) => x === v['tests']) ||
    (v['tests'] === 'changed' && !v['stale'])
  )
    return false;
  const d = v['decision'];
  if (v['state'] === 'completed')
    return (
      d.status === 'allowed' &&
      verdict(v['verdict']) &&
      new TextEncoder().encode(JSON.stringify(v)).length <= LOCAL_RUNTIME_MAX_FRAME - 1024
    );
  if (v['verdict'] !== null) return false;
  if (d.status === 'pending') return v['state'] === 'pending';
  if (d.status !== 'allowed') return v['state'] === 'no_review';
  return ['unconfirmed', 'requested', 'dispatching', 'outcome_unknown'].some(
    (x) => x === v['state'],
  );
}
