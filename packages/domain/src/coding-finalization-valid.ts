import {
  FINALIZATION_PREVIEW_MS,
  type CodingFinalizationAssets,
  type CodingFinalizationBinding,
  type CodingFinalizationLeaseBinding,
  type CodingFinalizationOwnerIdentity,
  type CodingFinalizationPreview,
  type CodingFinalizationProject,
  type CodingFinalizationRegistryIdentity,
  type CodingFinalizationRelease,
  type CodingFinalizationReleaseReceipt,
  type CodingFinalizationSelection,
  type CodingFinalizationTaskIdentity,
} from './coding-finalization.js';
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
export function validCodingFinalizationSelection(
  value: unknown,
): value is CodingFinalizationSelection {
  return (
    record(value) &&
    exactKeys(value, ['workspaceId', 'roomId', 'requestId', 'taskId']) &&
    text(value['workspaceId'], 128) &&
    text(value['roomId'], 128) &&
    text(value['requestId'], 128) &&
    text(value['taskId'], 4096)
  );
}
function validRegistry(value: unknown): value is CodingFinalizationRegistryIdentity {
  return (
    record(value) &&
    exactKeys(value, ['path', 'schema']) &&
    absolute(value['path']) &&
    text(value['schema'], 128)
  );
}
function validOwner(value: unknown): value is CodingFinalizationOwnerIdentity {
  return (
    record(value) &&
    exactKeys(value, ['profileOwnerId', 'epochId']) &&
    text(value['profileOwnerId'], 8192) &&
    (value['epochId'] === null || text(value['epochId'], 8192))
  );
}
function validTask(value: unknown): value is CodingFinalizationTaskIdentity {
  return (
    record(value) &&
    exactKeys(value, [
      'id',
      'originalTaskId',
      'workspaceId',
      'ownerRoomId',
      'devBotId',
      'reviewRoomId',
      'reviewBotId',
      'createdAt',
    ]) &&
    text(value['id'], 4096) &&
    value['originalTaskId'] === value['id'] &&
    text(value['workspaceId'], 128) &&
    text(value['ownerRoomId'], 128) &&
    text(value['devBotId'], 128) &&
    text(value['reviewRoomId'], 128) &&
    text(value['reviewBotId'], 128) &&
    text(value['createdAt'], 128)
  );
}
function validProject(value: unknown): value is CodingFinalizationProject {
  return (
    record(value) &&
    exactKeys(value, ['root', 'baseCommit', 'worktreeRoot']) &&
    absolute(value['root']) &&
    typeof value['baseCommit'] === 'string' &&
    /^[a-f0-9]{40,64}$/.test(value['baseCommit']) &&
    absolute(value['worktreeRoot'])
  );
}
function validPolicy(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, ['version', 'digest']) &&
    value['version'] === 1 &&
    hex(value['digest'])
  );
}
function validAssets(value: unknown): value is CodingFinalizationAssets {
  return (
    record(value) &&
    exactKeys(value, ['changesets', 'reviews', 'evidence']) &&
    hashes(value['changesets']) &&
    texts(value['reviews']) &&
    hashes(value['evidence'])
  );
}
function validLease(value: unknown): value is CodingFinalizationLeaseBinding {
  return (
    record(value) &&
    exactKeys(value, [
      'token',
      'tokenHash',
      'holderHash',
      'projectRoot',
      'ownerId',
      'taskId',
      'requestId',
      'binding',
      'kind',
      'registry',
    ]) &&
    text(value['token'], 128) &&
    hex(value['tokenHash']) &&
    hex(value['holderHash']) &&
    absolute(value['projectRoot']) &&
    text(value['ownerId'], 8192) &&
    text(value['taskId'], 4096) &&
    text(value['requestId'], 4096) &&
    text(value['binding'], 1048576) &&
    ['coding', 'legacy-write', 'legacy-command'].includes(String(value['kind'])) &&
    validRegistry(value['registry'])
  );
}
export function validCodingFinalizationBinding(value: unknown): value is CodingFinalizationBinding {
  if (
    !record(value) ||
    !exactKeys(value, [
      'version',
      'operationId',
      'owner',
      'task',
      'project',
      'policy',
      'assets',
      'lease',
    ])
  )
    return false;
  const task = value['task'],
    lease = value['lease'],
    project = value['project'];
  return (
    value['version'] === 1 &&
    text(value['operationId'], 128) &&
    validOwner(value['owner']) &&
    validTask(task) &&
    validProject(project) &&
    validPolicy(value['policy']) &&
    validAssets(value['assets']) &&
    validLease(lease) &&
    lease['taskId'] === task.id &&
    lease['projectRoot'] === project.root &&
    validOwner(value['owner']) &&
    lease['ownerId'] === value['owner'].profileOwnerId
  );
}
export function validCodingFinalizationPreview(value: unknown): value is CodingFinalizationPreview {
  if (
    !record(value) ||
    !exactKeys(value, ['binding', 'decisionId', 'createdAt', 'expiresAt', 'holds', 'retained'])
  )
    return false;
  const holds = value['holds'],
    retained = value['retained'];
  return (
    validCodingFinalizationBinding(value['binding']) &&
    text(value['decisionId'], 4096) &&
    Number.isSafeInteger(value['createdAt']) &&
    Number.isSafeInteger(value['expiresAt']) &&
    (value['expiresAt'] as number) - (value['createdAt'] as number) === FINALIZATION_PREVIEW_MS &&
    Array.isArray(holds) &&
    holds.length <= 10000 &&
    holds.every(
      (hold) =>
        record(hold) &&
        exactKeys(hold, ['id', 'kind', 'outcome', 'scope']) &&
        text(hold['id'], 4096) &&
        text(hold['kind'], 4096) &&
        text(hold['outcome'], 4096) &&
        (hold['scope'] === 'global' || hold['scope'] === 'task'),
    ) &&
    Array.isArray(retained) &&
    retained.length <= 128 &&
    retained.every((entry) => text(entry, 4096))
  );
}
export function validCodingFinalizationReleaseReceipt(
  value: unknown,
): value is CodingFinalizationReleaseReceipt {
  return (
    record(value) &&
    exactKeys(value, [
      'version',
      'operationId',
      'bindingDigest',
      'taskId',
      'workspaceId',
      'ownerId',
      'projectRoot',
      'tokenHash',
      'holderHash',
      'releasedAt',
      'registry',
    ]) &&
    value['version'] === 1 &&
    text(value['operationId'], 128) &&
    hex(value['bindingDigest']) &&
    text(value['taskId'], 4096) &&
    text(value['workspaceId'], 128) &&
    text(value['ownerId'], 8192) &&
    absolute(value['projectRoot']) &&
    hex(value['tokenHash']) &&
    hex(value['holderHash']) &&
    text(value['releasedAt'], 128) &&
    validRegistry(value['registry'])
  );
}
export function validCodingFinalizationRelease(value: unknown): value is CodingFinalizationRelease {
  if (!record(value) || !exactKeys(value, ['state', 'outcome', 'receipt', 'detail'])) return false;
  const state = value['state'],
    outcome = value['outcome'],
    receipt = value['receipt'];
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
  if (state === 'released')
    return outcome === 'released' && validCodingFinalizationReleaseReceipt(receipt);
  if (receipt !== null) return false;
  if (state === 'not_started' || state === 'pending') return outcome === null;
  // `unproven` may be an exact failed outcome or an unknown one (null); neither is a release.
  return outcome === null || outcome !== 'released';
}
