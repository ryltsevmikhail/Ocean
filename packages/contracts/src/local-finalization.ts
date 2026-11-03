import { localApplicationId } from './local-profile.js';
import { bindingDigest, isLocalDecision, type LocalDecision } from './local-runtime-decisions.js';
import { localId } from './local-runtime-queries.js';
import { localRuntimeRecord } from './local-runtime.js';
export const LOCAL_FINALIZATION_METHODS = [
  'coding.finalize.preview',
  'coding.finalize.result',
] as const;
export interface LocalFinalizationSelection {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly taskId: string;
}
export interface LocalFinalizationRegistry {
  readonly path: string;
  readonly schema: string;
}
export interface LocalFinalizationReleaseReceipt {
  readonly version: 1;
  readonly operationId: string;
  readonly bindingDigest: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly projectRoot: string;
  readonly tokenHash: string;
  readonly holderHash: string;
  readonly releasedAt: string;
  readonly registry: LocalFinalizationRegistry;
}
export interface LocalFinalizationRelease {
  readonly state: 'not_started' | 'pending' | 'released' | 'unproven';
  readonly outcome: string | null;
  readonly receipt: LocalFinalizationReleaseReceipt | null;
  readonly detail: string | null;
}
export interface LocalFinalizationRetained {
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly worktreeRoot: string;
  readonly policyVersion: 1;
  readonly policyDigest: string;
  readonly changesets: readonly string[];
  readonly reviews: readonly string[];
  readonly evidence: readonly string[];
}
export interface LocalFinalizationResult {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly state: 'preview' | 'finalizing' | 'finalized' | 'uncertain' | 'refused';
  readonly reason: string | null;
  readonly bindingDigest: string;
  readonly taskStatus: 'reserved' | 'cancelled' | 'finalizing' | 'finalized';
  readonly release: LocalFinalizationRelease;
  readonly retained: LocalFinalizationRetained;
}
const text = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const absolute = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  value.length <= 8192 &&
  !value.includes('\0');
const hashes = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= 100000 &&
  value.every((entry) => typeof entry === 'string' && /^[a-f0-9]{64}$/.test(entry));
const texts = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length <= 100000 && value.every((entry) => text(entry));
function registry(value: unknown): value is LocalFinalizationRegistry {
  return (
    localRuntimeRecord(value) &&
    Object.keys(value).length === 2 &&
    absolute(value['path']) &&
    text(value['schema'], 128)
  );
}
function receipt(value: unknown): value is LocalFinalizationReleaseReceipt {
  return (
    localRuntimeRecord(value) &&
    Object.keys(value).length === 11 &&
    value['version'] === 1 &&
    text(value['operationId'], 128) &&
    bindingDigest(value['bindingDigest']) &&
    text(value['taskId']) &&
    text(value['workspaceId'], 128) &&
    text(value['ownerId'], 8192) &&
    absolute(value['projectRoot']) &&
    bindingDigest(value['tokenHash']) &&
    bindingDigest(value['holderHash']) &&
    text(value['releasedAt'], 128) &&
    registry(value['registry'])
  );
}
function release(value: unknown): value is LocalFinalizationRelease {
  if (!localRuntimeRecord(value) || Object.keys(value).length !== 4) return false;
  const state = value['state'],
    outcome = value['outcome'];
  if (!['not_started', 'pending', 'released', 'unproven'].includes(String(state))) return false;
  if (
    outcome !== null &&
    (typeof outcome !== 'string' ||
      ![
        'released',
        'absent',
        'mismatch',
        'receipt_conflict',
        'registry_missing',
        'registry_corrupt',
        'thrown',
      ].includes(outcome))
  )
    return false;
  if (value['detail'] !== null && !text(value['detail'], 8192)) return false;
  if (state === 'released') return outcome === 'released' && receipt(value['receipt']);
  if (value['receipt'] !== null) return false;
  return state === 'not_started' || state === 'pending'
    ? outcome === null
    : outcome === null || outcome !== 'released';
}
function retained(value: unknown): value is LocalFinalizationRetained {
  return (
    localRuntimeRecord(value) &&
    Object.keys(value).length === 8 &&
    absolute(value['projectRoot']) &&
    typeof value['baseCommit'] === 'string' &&
    /^[a-f0-9]{40,64}$/.test(value['baseCommit']) &&
    absolute(value['worktreeRoot']) &&
    value['policyVersion'] === 1 &&
    bindingDigest(value['policyDigest']) &&
    hashes(value['changesets']) &&
    texts(value['reviews']) &&
    hashes(value['evidence'])
  );
}
export function isLocalFinalizationSelection(value: unknown): value is LocalFinalizationSelection {
  return (
    localRuntimeRecord(value) &&
    Object.keys(value).length === 4 &&
    localId(value['workspaceId']) &&
    localId(value['roomId']) &&
    text(value['requestId'], 128) &&
    localApplicationId(value['taskId'])
  );
}
/** The preview call returns the common decision card of a `task-finalization` kind. */
export function isLocalFinalizationCard(value: unknown): value is LocalDecision {
  return isLocalDecision(value) && value.kind === 'task-finalization';
}
export function isLocalFinalizationResult(value: unknown): value is LocalFinalizationResult {
  if (!localRuntimeRecord(value) || Object.keys(value).length !== 10) return false;
  const state = String(value['state']),
    status = String(value['taskStatus']);
  return (
    localId(value['workspaceId']) &&
    localId(value['roomId']) &&
    text(value['requestId'], 128) &&
    text(value['taskId']) &&
    ['preview', 'finalizing', 'finalized', 'uncertain', 'refused'].includes(state) &&
    (value['reason'] === null || text(value['reason'], 8192)) &&
    bindingDigest(value['bindingDigest']) &&
    ['reserved', 'cancelled', 'finalizing', 'finalized'].includes(status) &&
    // A refused record keeps its historical state while `taskStatus` reflects
    // the current task, which may have been finalized afterwards.
    ((state === 'preview' && status === 'reserved') ||
      (state === 'refused' && ['reserved', 'finalizing', 'finalized'].includes(status)) ||
      (['finalizing', 'uncertain'].includes(state) && status === 'finalizing') ||
      (state === 'finalized' && status === 'finalized')) &&
    release(value['release']) &&
    retained(value['retained'])
  );
}
