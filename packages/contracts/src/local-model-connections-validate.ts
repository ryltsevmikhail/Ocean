import type {
  LocalModelConnectionsQuery,
  LocalModelConnectionQuery,
  LocalModelConnectionSetRequest,
  LocalModelConnectionRevisionRequest,
  LocalModelConnectionStatus,
  LocalModelCheckMetadata,
  LocalModelConnectionCheckResponse,
} from './local-model-connections.js';
import {
  modelObject as obj,
  modelText as text,
  modelPosition as pos,
  modelPositive as positive,
  modelDate as date,
  modelEnum as en,
  modelNullable as nullable,
  modelPageQuery,
} from './local-model-validation.js';
export const isLocalModelConnectionsQuery = (v: unknown): v is LocalModelConnectionsQuery =>
  modelPageQuery(v, [], ['workspaceId'], 256) &&
  obj(v, [], ['workspaceId', 'after', 'limit']) &&
  (v['workspaceId'] === undefined || text(v['workspaceId'], 128));
export const isLocalModelConnectionQuery = (v: unknown): v is LocalModelConnectionQuery =>
  obj(v, ['connectionId']) && text(v['connectionId']);
const revisionKeys = ['connectionId', 'requestId', 'expectedRevision'];
export const isLocalModelConnectionRevisionRequest = (
  v: unknown,
): v is LocalModelConnectionRevisionRequest =>
  obj(v, revisionKeys) &&
  text(v['connectionId']) &&
  text(v['requestId'], 128) &&
  pos(v['expectedRevision']);
const setKeys = [...revisionKeys, 'providerId', 'kind', 'endpoint', 'auth', 'defaultModelId'];
function endpoint(kind: unknown, v: unknown) {
  if (!text(v, 2048)) return false;
  try {
    const u = new URL(v);
    return (
      u.username === '' &&
      u.password === '' &&
      !/[?#]/.test(v) &&
      u.origin + (u.pathname === '/' ? '' : u.pathname) === v &&
      (kind === 'cloud'
        ? u.protocol === 'https:'
        : kind === 'local' &&
          ['http:', 'https:'].includes(u.protocol) &&
          (u.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(u.hostname)))
    );
  } catch {
    return false;
  }
}
export const isLocalModelConnectionSetRequest = (v: unknown): v is LocalModelConnectionSetRequest =>
  obj(v, setKeys, ['key']) &&
  text(v['connectionId']) &&
  text(v['requestId'], 128) &&
  nullable(v['expectedRevision'], pos) &&
  text(v['providerId'], 64) &&
  en(v['kind'], ['cloud', 'local']) &&
  endpoint(v['kind'], v['endpoint']) &&
  en(v['auth'], ['api_key', 'none']) &&
  text(v['defaultModelId']) &&
  (v['key'] === undefined ||
    (typeof v['key'] === 'string' &&
      v['key'].length <= 512 &&
      v['key'].trim() !== '' &&
      !v['key'].includes('\0'))) &&
  (v['auth'] !== 'none' || (v['kind'] === 'local' && v['key'] === undefined));
function capabilities(v: unknown) {
  return (
    obj(v, [
      'tools',
      'streaming',
      'inputModalities',
      'contextTokens',
      'maxOutputTokens',
      'usage',
    ]) &&
    typeof v['tools'] === 'boolean' &&
    typeof v['streaming'] === 'boolean' &&
    Array.isArray(v['inputModalities']) &&
    v['inputModalities'].length >= 1 &&
    v['inputModalities'].length <= 2 &&
    v['inputModalities'].includes('text') &&
    v['inputModalities'].every((x) => x === 'text' || x === 'image') &&
    new Set(v['inputModalities']).size === v['inputModalities'].length &&
    nullable(v['contextTokens'], positive) &&
    nullable(v['maxOutputTokens'], positive) &&
    en(v['usage'], ['reported', 'optional', 'unavailable'])
  );
}
export function catalog(v: unknown) {
  return (
    Array.isArray(v) &&
    v.length <= 200 &&
    v.every(
      (x) =>
        obj(x, ['modelId', 'capabilities']) &&
        text(x['modelId']) &&
        capabilities(x['capabilities']),
    )
  );
}
export function qualification(v: unknown) {
  return (
    obj(v, [
      'modelId',
      'artifactDigest',
      'backendVersion',
      'capabilities',
      'configuredContextTokens',
    ]) &&
    text(v['modelId']) &&
    typeof v['artifactDigest'] === 'string' &&
    /^[a-f0-9]{64}$/.test(v['artifactDigest']) &&
    text(v['backendVersion'], 128) &&
    positive(v['configuredContextTokens']) &&
    capabilities(v['capabilities']) &&
    obj(v['capabilities'], [
      'tools',
      'streaming',
      'inputModalities',
      'contextTokens',
      'maxOutputTokens',
      'usage',
    ]) &&
    v['capabilities']['contextTokens'] === v['configuredContextTokens']
  );
}
const checkKeys = [
  'connectionId',
  'outcome',
  'httpStatus',
  'durationMs',
  'models',
  'modelSupported',
  'source',
  'revision',
  'checkedAt',
];
const source = (v: unknown) => en(v, ['saved', 'external', 'auth_none', 'injected', 'none']);
export function isLocalModelCheckMetadata(v: unknown): v is LocalModelCheckMetadata {
  return (
    obj(v, checkKeys) &&
    text(v['connectionId']) &&
    en(v['outcome'], ['ok', 'auth', 'network', 'timeout', 'cancelled', 'server', 'unavailable']) &&
    (v['httpStatus'] === null ||
      (pos(v['httpStatus']) && v['httpStatus'] >= 100 && v['httpStatus'] <= 599)) &&
    pos(v['durationMs']) &&
    Array.isArray(v['models']) &&
    v['models'].length <= 200 &&
    v['models'].every((x) => text(x)) &&
    typeof v['modelSupported'] === 'boolean' &&
    source(v['source']) &&
    pos(v['revision']) &&
    date(v['checkedAt'])
  );
}
export const descriptorKeys = [
  'connectionId',
  'providerId',
  'kind',
  'endpoint',
  'auth',
  'defaultModelId',
  'revision',
];
export function descriptor(v: Record<string, unknown>) {
  return (
    text(v['connectionId']) &&
    text(v['providerId'], 64) &&
    en(v['kind'], ['cloud', 'local']) &&
    (v['endpoint'] === null || endpoint(v['kind'], v['endpoint'])) &&
    en(v['auth'], ['api_key', 'none']) &&
    nullable(v['defaultModelId'], (x) => text(x)) &&
    pos(v['revision'])
  );
}
export function isLocalModelConnectionStatus(v: unknown): v is LocalModelConnectionStatus {
  return (
    obj(v, [
      ...descriptorKeys,
      'source',
      'state',
      'models',
      'savedKey',
      'writable',
      'code',
      'lastCheck',
    ]) &&
    descriptor(v) &&
    source(v['source']) &&
    en(v['state'], [
      'connected',
      'disconnected',
      'unverified',
      'absent',
      'restored',
      'invalid_model',
    ]) &&
    catalog(v['models']) &&
    typeof v['savedKey'] === 'boolean' &&
    typeof v['writable'] === 'boolean' &&
    (v['code'] === null || (typeof v['code'] === 'string' && /^[a-z_]{1,64}$/.test(v['code']))) &&
    nullable(
      v['lastCheck'],
      (x) => isLocalModelCheckMetadata(x) && x.connectionId === v['connectionId'],
    )
  );
}
export function isLocalModelConnectionCheckResponse(
  v: unknown,
): v is LocalModelConnectionCheckResponse {
  if (
    !obj(v, ['status', 'check']) ||
    !isLocalModelConnectionStatus(v['status']) ||
    !obj(v['check'], [...checkKeys, 'persisted'])
  )
    return false;
  const { persisted, ...check } = v['check'];
  return (
    typeof persisted === 'boolean' &&
    isLocalModelCheckMetadata(check) &&
    check.connectionId === v['status'].connectionId
  );
}
