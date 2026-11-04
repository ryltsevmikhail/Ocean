import type { ModelCheckMetadata, ModelConnectionStatus } from './model-connection-types.js';
import { readCheckMetadata } from './provider-connection-resolution.js';
export const modelObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export function readModelCheck(value: unknown, connectionId: string): ModelCheckMetadata | null {
  if (!modelObject(value)) return null;
  if (value['connectionId'] !== undefined && value['connectionId'] !== connectionId) return null;
  const source = value['source'];
  const old = readCheckMetadata(source === 'auth_none' ? { ...value, source: 'none' } : value);
  return old === null
    ? null
    : { ...old, connectionId, source: source === 'auth_none' ? source : old.source };
}
/** Closed public snapshots are validated on disk reads, never rebuilt from current credentials. */
export function modelPublicResult(value: unknown): { version: 1; status: ModelConnectionStatus } {
  if (!modelObject(value) || value['version'] !== 1 || !modelObject(value['status']))
    throw Error('connection_unverified');
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'status'))
    throw Error('connection_unverified');
  const s = value['status'];
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (
    !str(s['connectionId']) ||
    !str(s['providerId']) ||
    (s['kind'] !== 'cloud' && s['kind'] !== 'local') ||
    (s['auth'] !== 'api_key' && s['auth'] !== 'none') ||
    !(s['endpoint'] === null || str(s['endpoint'])) ||
    !(s['defaultModelId'] === null || str(s['defaultModelId'])) ||
    !['saved', 'external', 'auth_none', 'injected', 'none'].some((v) => v === s['source']) ||
    !['connected', 'disconnected', 'unverified', 'absent', 'restored', 'invalid_model'].some(
      (v) => v === s['state'],
    ) ||
    typeof s['revision'] !== 'number' ||
    !Number.isSafeInteger(s['revision']) ||
    s['revision'] < 0 ||
    typeof s['savedKey'] !== 'boolean' ||
    typeof s['writable'] !== 'boolean' ||
    !(s['code'] === null || str(s['code'])) ||
    !Array.isArray(s['models']) ||
    !s['models'].every(
      (m: unknown) =>
        modelObject(m) &&
        Object.keys(m).every((k) => ['modelId', 'capabilities'].includes(k)) &&
        str(m['modelId']) &&
        validCapabilities(m['capabilities']),
    ) ||
    !(
      s['lastCheck'] === null ||
      (modelObject(s['lastCheck']) &&
        s['lastCheck']['connectionId'] === s['connectionId'] &&
        Object.keys(s['lastCheck']).every((key) =>
          [
            'connectionId',
            'outcome',
            'httpStatus',
            'durationMs',
            'models',
            'modelSupported',
            'source',
            'revision',
            'checkedAt',
          ].includes(key),
        ) &&
        readModelCheck(s['lastCheck'], s['connectionId'] as string) !== null)
    )
  )
    throw Error('connection_unverified');
  const allowed = [
    'connectionId',
    'providerId',
    'kind',
    'endpoint',
    'auth',
    'defaultModelId',
    'source',
    'state',
    'models',
    'revision',
    'savedKey',
    'writable',
    'code',
    'lastCheck',
  ];
  if (Object.keys(s).some((key) => !allowed.includes(key))) throw Error('connection_unverified');
  return structuredClone(value) as unknown as { version: 1; status: ModelConnectionStatus };
}
function validCapabilities(value: unknown): boolean {
  if (
    !modelObject(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          'tools',
          'streaming',
          'inputModalities',
          'contextTokens',
          'maxOutputTokens',
          'usage',
        ].includes(k),
    )
  )
    return false;
  const limit = (v: unknown) =>
    v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0);
  return (
    typeof value['tools'] === 'boolean' &&
    typeof value['streaming'] === 'boolean' &&
    Array.isArray(value['inputModalities']) &&
    value['inputModalities'].every((v: unknown) => v === 'text' || v === 'image') &&
    limit(value['contextTokens']) &&
    limit(value['maxOutputTokens']) &&
    ['reported', 'optional', 'unavailable'].some((v) => v === value['usage'])
  );
}
