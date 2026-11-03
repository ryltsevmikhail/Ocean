import { localId, localPosition } from './local-runtime-queries.js';
import { localRuntimeRecord } from './local-runtime.js';
import type { LocalRoomScope, LocalRunQuery } from './local-runtime-turns.js';
export const LOCAL_DECISION_METHODS = [
  'decisions.list',
  'decisions.get',
  'decisions.preview',
  'decisions.resolve',
  'reviews.get',
  'reviews.continue',
  'reviews.result',
] as const;
export const PREVIEW_CHUNK = 32 * 1024;
export interface LocalDecisionRef extends LocalRunQuery {
  readonly decisionId: string;
}
export interface LocalDecision extends LocalDecisionRef {
  readonly kind: 'write' | 'test' | 'continue-text-only' | 'restore-rebind';
  readonly status:
    'pending' | 'allowed' | 'denied' | 'cancelled' | 'expired' | 'invalidated' | 'interrupted';
  readonly version: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly bindingDigest: string;
  readonly previewLength: number;
}
export interface LocalDecisionReply extends LocalDecisionRef {
  readonly choice: 'allow-once' | 'deny' | 'cancel';
  readonly expectedVersion: number;
  readonly bindingDigest: string;
}
export interface LocalContinuation extends LocalRunQuery {
  readonly requestId: string;
  readonly reviewVersion: string;
  readonly reason: string;
}
export interface LocalReviewSnapshot extends LocalRunQuery {
  readonly turnStatus: string | null;
  readonly taskStatus: string;
  readonly taskVersion: number;
  readonly version: string;
  readonly globalPendingEffects: number;
  readonly relatedPendingEffects: number;
  readonly effects: readonly {
    id: string;
    tool: string;
    taskRunId: string;
    attemptId: string;
    outcome: string;
  }[];
  readonly canAcknowledge: boolean;
  readonly mode: 'text_only' | null;
}
const refKeys = ['workspaceId', 'roomId', 'runId', 'decisionId'];
function keys(
  v: unknown,
  ids: readonly string[],
  other: readonly string[],
): v is Record<string, unknown> {
  return (
    localRuntimeRecord(v) &&
    ids.every((k) => localId(v[k])) &&
    Object.keys(v).every((k) => ids.includes(k) || other.includes(k))
  );
}
export const bindingDigest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const isDecisionRef = (v: unknown): v is LocalDecisionRef => keys(v, refKeys, []);
export const isDecisionReply = (v: unknown): v is LocalDecisionReply =>
  keys(v, refKeys, ['expectedVersion', 'bindingDigest', 'choice']) &&
  localPosition(v['expectedVersion']) &&
  bindingDigest(v['bindingDigest']) &&
  ['allow-once', 'deny', 'cancel'].some((c) => c === v['choice']);
export const isDecisionChunkQuery = (v: unknown): v is LocalDecisionRef & { offset: number } =>
  keys(v, refKeys, ['offset']) && localPosition(v['offset']);
export const isReviewChunkQuery = (
  v: unknown,
): v is LocalRoomScope & { offset: number; version?: string; runId?: string } =>
  keys(v, ['workspaceId', 'roomId'], ['offset', 'version', 'runId']) &&
  (v['runId'] === undefined || localId(v['runId'])) &&
  localPosition(v['offset']) &&
  (v['version'] === undefined || bindingDigest(v['version']));
export const isLocalRoomScope = (v: unknown): v is LocalRoomScope =>
  keys(v, ['workspaceId', 'roomId'], []);
const validText = (v: unknown, max: number) =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  !v.includes('\0') &&
  !/[\uD800-\uDFFF]/u.test(v) &&
  new TextEncoder().encode(v).length <= max;
export const isContinuation = (v: unknown): v is LocalContinuation =>
  keys(v, ['workspaceId', 'roomId', 'runId', 'requestId'], ['reviewVersion', 'reason']) &&
  bindingDigest(v['reviewVersion']) &&
  validText(v['reason'], 2048) &&
  validText(v['requestId'], 128);
export function isLocalDecision(v: unknown): v is LocalDecision {
  return (
    keys(v, refKeys, [
      'kind',
      'version',
      'createdAt',
      'expiresAt',
      'status',
      'previewLength',
      'bindingDigest',
    ]) &&
    ['write', 'test', 'continue-text-only', 'restore-rebind'].some((k) => k === v['kind']) &&
    bindingDigest(v['bindingDigest']) &&
    localPosition(v['previewLength']) &&
    localPosition(v['createdAt']) &&
    v['expiresAt'] === v['createdAt'] + 300000 &&
    ((v['version'] === 1 && v['status'] === 'pending') ||
      (v['version'] === 2 &&
        ['allowed', 'denied', 'cancelled', 'expired', 'invalidated', 'interrupted'].some(
          (k) => k === v['status'],
        )))
  );
}
export function isReviewSnapshot(v: unknown): v is LocalReviewSnapshot {
  return (
    keys(
      v,
      ['workspaceId', 'roomId', 'runId'],
      [
        'version',
        'taskStatus',
        'turnStatus',
        'taskVersion',
        'globalPendingEffects',
        'relatedPendingEffects',
        'effects',
        'mode',
        'canAcknowledge',
      ],
    ) &&
    bindingDigest(v['version']) &&
    typeof v['taskStatus'] === 'string' &&
    (v['turnStatus'] === null || typeof v['turnStatus'] === 'string') &&
    localPosition(v['taskVersion']) &&
    localPosition(v['globalPendingEffects']) &&
    localPosition(v['relatedPendingEffects']) &&
    typeof v['canAcknowledge'] === 'boolean' &&
    (v['mode'] === null || v['mode'] === 'text_only') &&
    Array.isArray(v['effects']) &&
    v['effects'].every(
      (e) =>
        localRuntimeRecord(e) &&
        e['taskRunId'] === v['runId'] &&
        ['id', 'tool', 'attemptId', 'outcome'].every((k) => typeof e[k] === 'string'),
    )
  );
}
