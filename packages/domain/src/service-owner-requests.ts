import { canonicalJson } from './plugin-catalog.js';
import {
  validServiceConfiguration,
  validServiceConnectionVersions,
  type ServiceConfiguration,
  type ServiceConnectionVersions,
} from './service-connection.js';
import { validOwnerScopeGrant } from './owner-scope-grant.js';
import type { OwnerScopeIntent } from './owner-scope-grant.js';
export interface ServiceConnectionRequest {
  readonly requestId: string;
  readonly connectionId: string;
  readonly expectedVersions: ServiceConnectionVersions;
}
export interface ServiceConnectionSetRequest extends Omit<
  ServiceConnectionRequest,
  'expectedVersions'
> {
  readonly expectedVersions: ServiceConnectionVersions | null;
  readonly name: string;
  readonly configuration: ServiceConfiguration;
  readonly metadataPermission: 'none' | 'allow';
  readonly key?: string;
  readonly removeKey?: boolean;
}
export interface ServiceGrantSetRequest {
  readonly requestId: string;
  readonly expectedRevision: number | null;
  readonly intent: OwnerScopeIntent;
}
export interface ServiceGrantRevokeRequest {
  readonly requestId: string;
  readonly grantId: string;
  readonly expectedRevision: number;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const text = (v: unknown, max = 128): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= max &&
  [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) => [...required, ...optional].includes(k));
const revision = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 1;
export const validServiceOwnerQuery = (v: unknown): v is Record<string, never> =>
  object(v) && keys(v, []);
export const validServiceReceiptQuery = (v: unknown): v is { requestId: string } =>
  object(v) && keys(v, ['requestId']) && text(v['requestId']);
export function validServiceConnectionRequest(v: unknown): v is ServiceConnectionRequest {
  return (
    object(v) &&
    keys(v, ['requestId', 'connectionId', 'expectedVersions']) &&
    text(v['requestId']) &&
    text(v['connectionId']) &&
    exactVersions(v['expectedVersions'])
  );
}
function exactVersions(v: unknown) {
  return (
    object(v) &&
    keys(v, ['configRevision', 'trustRevision', 'credentialRevision']) &&
    validServiceConnectionVersions(v)
  );
}
export function validServiceConnectionSetRequest(v: unknown): v is ServiceConnectionSetRequest {
  return (
    object(v) &&
    keys(
      v,
      [
        'requestId',
        'connectionId',
        'expectedVersions',
        'name',
        'configuration',
        'metadataPermission',
      ],
      ['key', 'removeKey'],
    ) &&
    text(v['requestId']) &&
    text(v['connectionId']) &&
    (v['expectedVersions'] === null || exactVersions(v['expectedVersions'])) &&
    text(v['name'], 256) &&
    validServiceConfiguration(v['configuration']) &&
    (v['metadataPermission'] === 'none' || v['metadataPermission'] === 'allow') &&
    (!Object.hasOwn(v, 'key') || text(v['key'], 512)) &&
    (!Object.hasOwn(v, 'removeKey') || typeof v['removeKey'] === 'boolean') &&
    !(Object.hasOwn(v, 'key') && v['removeKey'] === true) &&
    (v['configuration'].kind !== 'stdio' ||
      (!Object.hasOwn(v, 'key') && !Object.hasOwn(v, 'removeKey')))
  );
}
export function validServiceGrantSetRequest(v: unknown): v is ServiceGrantSetRequest {
  if (
    !object(v) ||
    !keys(v, ['requestId', 'expectedRevision', 'intent']) ||
    !text(v['requestId']) ||
    !(v['expectedRevision'] === null || revision(v['expectedRevision']))
  )
    return false;
  const i = v['intent'];
  if (!object(i) || !keys(i, ['id', 'subject', 'permissions', 'limits'], ['mode'])) return false;
  const at = '2026-01-01T00:00:00.000Z';
  return (
    validOwnerScopeGrant({
      ...i,
      mode: Object.hasOwn(i, 'mode') ? i['mode'] : 'autonomous',
      policyVersion: 2,
      revision: 1,
      state: 'active',
      owner: { ownerId: 'owner', source: 'owner-interface', issuedAt: at },
      updatedAt: at,
    }) && canonicalJson(v).length <= 65536
  );
}
export function validServiceGrantRevokeRequest(v: unknown): v is ServiceGrantRevokeRequest {
  return (
    object(v) &&
    keys(v, ['requestId', 'grantId', 'expectedRevision']) &&
    text(v['requestId']) &&
    text(v['grantId']) &&
    revision(v['expectedRevision'])
  );
}
