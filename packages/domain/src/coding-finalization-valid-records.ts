import type { CodingFinalizationRecord, CodingFinalizationResult } from './coding-finalization.js';
import {
  validCodingFinalizationRelease,
  validCodingFinalizationPreview,
} from './coding-finalization-valid.js';
const MAX_TEXT = 4096;
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const absolute = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  !value.includes('\0') &&
  value.length <= 8192;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const hashes = (value: unknown, limit = 100000): value is readonly string[] =>
  Array.isArray(value) && value.length <= limit && value.every(hex);
const texts = (value: unknown, limit = 100000): value is readonly string[] =>
  Array.isArray(value) && value.length <= limit && value.every((entry) => text(entry, 4096));
export function validCodingFinalizationRecord(value: unknown): value is CodingFinalizationRecord {
  if (
    !record(value) ||
    !exactKeys(value, [
      'requestId',
      'taskId',
      'projectRoot',
      'revision',
      'state',
      'decisionId',
      'bindingDigest',
      'preview',
      'release',
      'reason',
    ]) ||
    !text(value['requestId'], 128) ||
    !text(value['taskId'], 4096) ||
    !absolute(value['projectRoot']) ||
    !Number.isSafeInteger(value['revision']) ||
    (value['revision'] as number) < 1 ||
    !text(value['decisionId'], 4096) ||
    !hex(value['bindingDigest']) ||
    !validCodingFinalizationPreview(value['preview']) ||
    !validCodingFinalizationRelease(value['release']) ||
    (value['reason'] !== null && !text(value['reason'], 8192)) ||
    !['preview', 'finalizing', 'finalized', 'uncertain', 'refused'].includes(String(value['state']))
  )
    return false;
  const preview = value['preview'],
    release = value['release'];
  return (
    preview.binding.operationId === value['requestId'] &&
    preview.binding.task.id === value['taskId'] &&
    preview.binding.project.root === value['projectRoot'] &&
    ((value['state'] === 'preview' && release.state === 'not_started') ||
      (value['state'] === 'finalizing' && release.state === 'pending') ||
      (value['state'] === 'finalized' && release.state === 'released') ||
      (value['state'] === 'uncertain' && release.state === 'unproven') ||
      (value['state'] === 'refused' && release.state === 'not_started'))
  );
}
export function validCodingFinalizationResult(value: unknown): value is CodingFinalizationResult {
  if (
    !record(value) ||
    !exactKeys(value, [
      'workspaceId',
      'roomId',
      'requestId',
      'taskId',
      'state',
      'reason',
      'bindingDigest',
      'taskStatus',
      'release',
      'retained',
    ])
  )
    return false;
  const retained = value['retained'],
    state = String(value['state']);
  return (
    text(value['workspaceId'], 128) &&
    text(value['roomId'], 128) &&
    text(value['requestId'], 128) &&
    text(value['taskId'], 4096) &&
    ['preview', 'finalizing', 'finalized', 'uncertain', 'refused'].includes(state) &&
    (value['reason'] === null || text(value['reason'], 8192)) &&
    hex(value['bindingDigest']) &&
    ['reserved', 'cancelled', 'finalizing', 'finalized'].includes(String(value['taskStatus'])) &&
    // `taskStatus` is the current task state while `state` is the historical
    // record state: a refused record stays readable after the same task is
    // later finalized, so refused accepts every prepared-lifecycle status.
    ((state === 'preview' && value['taskStatus'] === 'reserved') ||
      (state === 'refused' &&
        ['reserved', 'finalizing', 'finalized'].includes(String(value['taskStatus']))) ||
      (['finalizing', 'uncertain'].includes(state) && value['taskStatus'] === 'finalizing') ||
      (state === 'finalized' && value['taskStatus'] === 'finalized')) &&
    validCodingFinalizationRelease(value['release']) &&
    record(retained) &&
    exactKeys(retained, [
      'projectRoot',
      'baseCommit',
      'worktreeRoot',
      'policyVersion',
      'policyDigest',
      'changesets',
      'reviews',
      'evidence',
    ]) &&
    absolute(retained['projectRoot']) &&
    typeof retained['baseCommit'] === 'string' &&
    /^[a-f0-9]{40,64}$/.test(retained['baseCommit']) &&
    absolute(retained['worktreeRoot']) &&
    retained['policyVersion'] === 1 &&
    hex(retained['policyDigest']) &&
    hashes(retained['changesets']) &&
    texts(retained['reviews']) &&
    hashes(retained['evidence'])
  );
}
