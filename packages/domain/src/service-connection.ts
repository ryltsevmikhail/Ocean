import { validCredentialReference } from './plugin-catalog.js';
import { validPluginSchemaDigest } from './plugin-connection.js';
import { validOwnerResourceScope, type OwnerResourceScope } from './effect-resource-scope.js';
import {
  authorityDenseArray,
  authorityBoundedJson,
  authorityInstant as instant,
  authorityKeys as keys,
  authorityObject as object,
  authorityRevision as revision,
  authorityText as text,
} from './service-authority-validation.js';
export interface ServiceConnectionVersions {
  readonly configRevision: number;
  readonly trustRevision: number;
  readonly credentialRevision: number;
}
export type ServiceConfiguration =
  | { readonly kind: 'http'; readonly url: string }
  | {
      readonly kind: 'stdio';
      readonly executable: string;
      readonly sha256: string;
      /** Optional exact sibling package.json used by the bundled server to read its version. */
      readonly packageJsonSha256?: string;
      /** Only the isolated /workspace directory may be passed to the pinned Node artifact. */
      readonly args: readonly string[];
    };
export interface ServiceTrustBinding {
  readonly ownerId: string;
  readonly metadataPermission: 'none' | 'allow';
  readonly identity:
    | { readonly status: 'unverified'; readonly label: string | null }
    | {
        readonly status: 'verified';
        readonly accountId: string;
        readonly evidenceReference: string;
      };
  /** Shape validation of evidence does not certify its source or enforcement. */
  readonly resourceEnforcement: readonly (
    | { readonly status: 'declared'; readonly scope: OwnerResourceScope }
    | {
        readonly status: 'evidenced';
        readonly scope: OwnerResourceScope;
        readonly evidenceReference: string;
      }
  )[];
}
export interface ServiceConnection extends ServiceConnectionVersions {
  readonly id: string;
  readonly name: string;
  readonly configuration: ServiceConfiguration;
  /** Non-secret env:UPPER_CASE_NAME handle; never literal credential bytes. */
  readonly credentialReference: string | null;
  readonly trust: ServiceTrustBinding;
  readonly state: 'active' | 'disconnected';
  readonly currentCatalogId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export function validServiceConnectionVersions(v: unknown): v is ServiceConnectionVersions {
  return (
    object(v) &&
    revision(v['configRevision']) &&
    revision(v['trustRevision']) &&
    revision(v['credentialRevision'])
  );
}
export function validServiceConfiguration(v: unknown): v is ServiceConfiguration {
  if (!object(v)) return false;
  if (v['kind'] === 'stdio')
    return (
      (keys(v, ['kind', 'executable', 'sha256', 'args']) ||
        (keys(v, ['kind', 'executable', 'sha256', 'args', 'packageJsonSha256']) &&
          validPluginSchemaDigest(v['packageJsonSha256']))) &&
      text(v['executable'], 4096) &&
      String(v['executable']).startsWith('/') &&
      validPluginSchemaDigest(v['sha256']) &&
      Array.isArray(v['args']) &&
      (v['args'].length === 0 || (v['args'].length === 1 && v['args'][0] === '/workspace')) &&
      authorityDenseArray(v['args'])
    );
  if (v['kind'] !== 'http' || !keys(v, ['kind', 'url']) || !text(v['url'], 4096)) return false;
  // No literal authentication headers, userinfo, query parameters or fragments.
  if (/\s/.test(v['url'])) return false;
  try {
    const url = new URL(v['url']);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
export function validServiceTrustBinding(v: unknown): v is ServiceTrustBinding {
  if (
    !object(v) ||
    !keys(v, ['ownerId', 'metadataPermission', 'identity', 'resourceEnforcement']) ||
    !text(v['ownerId']) ||
    (v['metadataPermission'] !== 'none' && v['metadataPermission'] !== 'allow')
  )
    return false;
  const i = v['identity'];
  if (
    !object(i) ||
    !(i['status'] === 'unverified'
      ? keys(i, ['status', 'label']) && (i['label'] === null || text(i['label'], 256))
      : i['status'] === 'verified' &&
        keys(i, ['status', 'accountId', 'evidenceReference']) &&
        text(i['accountId']) &&
        text(i['evidenceReference']))
  )
    return false;
  return (
    Array.isArray(v['resourceEnforcement']) &&
    v['resourceEnforcement'].length <= 256 &&
    authorityDenseArray(v['resourceEnforcement']) &&
    v['resourceEnforcement'].every(
      (e: unknown) =>
        object(e) &&
        validOwnerResourceScope(e['scope']) &&
        (e['status'] === 'declared'
          ? keys(e, ['status', 'scope'])
          : e['status'] === 'evidenced' &&
            keys(e, ['status', 'scope', 'evidenceReference']) &&
            text(e['evidenceReference'])),
    )
  );
}
export function validServiceConnection(v: unknown): v is ServiceConnection {
  return (
    object(v) &&
    keys(v, [
      'id',
      'name',
      'configRevision',
      'trustRevision',
      'credentialRevision',
      'configuration',
      'credentialReference',
      'trust',
      'state',
      'currentCatalogId',
      'createdAt',
      'updatedAt',
    ]) &&
    text(v['id']) &&
    text(v['name'], 256) &&
    validServiceConnectionVersions(v) &&
    validServiceConfiguration(v['configuration']) &&
    (v['credentialReference'] === null ||
      (typeof v['credentialReference'] === 'string' &&
        v['credentialReference'].startsWith('env:') &&
        validCredentialReference(v['credentialReference'].slice(4)))) &&
    validServiceTrustBinding(v['trust']) &&
    (v['state'] === 'active' || v['state'] === 'disconnected') &&
    (v['currentCatalogId'] === null || text(v['currentCatalogId'])) &&
    instant(v['createdAt']) &&
    instant(v['updatedAt']) &&
    authorityBoundedJson(v, 65536)
  );
}
