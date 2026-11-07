import { validPluginSchemaDigest } from './plugin-connection.js';
import {
  validServiceConnectionVersions,
  type ServiceConnectionVersions,
} from './service-connection.js';
import {
  authorityDenseArray,
  authorityBoundedJson,
  authorityInstant as instant,
  authorityKeys as keys,
  authorityObject as object,
  authorityText as text,
} from './service-authority-validation.js';
export const SERVICE_PLUGIN_MAX_TOOLS = 256;
export const SERVICE_PLUGIN_MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
export type ServiceJson =
  | null
  | boolean
  | number
  | string
  | readonly ServiceJson[]
  | { readonly [key: string]: ServiceJson };
export interface ServiceToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ServiceJson;
  readonly outputSchema: ServiceJson;
  readonly annotations: ServiceJson;
  readonly definitionDigest: string;
  readonly provenance: Readonly<Record<string, string>>;
}
export interface ServiceCatalogSnapshot extends ServiceConnectionVersions {
  readonly id: string;
  readonly connectionId: string;
  readonly completeness: 'complete';
  readonly observedAt: string;
  /** Non-authoritative protocol/adapter evidence, never owner permission. */
  readonly provenance: Readonly<Record<string, string>>;
  readonly tools: readonly ServiceToolDefinition[];
}
export function validServiceJson(v: unknown, depth = 0): v is ServiceJson {
  if (depth > 64) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v))
    return authorityDenseArray(v) && v.every((e: unknown) => validServiceJson(e, depth + 1));
  return object(v) && Object.values(v).every((e) => validServiceJson(e, depth + 1));
}
function provenance(v: unknown): boolean {
  return (
    object(v) &&
    Object.keys(v).length <= 16 &&
    Object.entries(v).every(([k, value]) => text(k) && text(value, 256))
  );
}
export function validServiceToolDefinition(v: unknown): v is ServiceToolDefinition {
  return (
    object(v) &&
    keys(v, [
      'name',
      'description',
      'inputSchema',
      'outputSchema',
      'annotations',
      'definitionDigest',
      'provenance',
    ]) &&
    text(v['name']) &&
    typeof v['description'] === 'string' &&
    validServiceJson(v['inputSchema']) &&
    validServiceJson(v['outputSchema']) &&
    validServiceJson(v['annotations']) &&
    validPluginSchemaDigest(v['definitionDigest']) &&
    provenance(v['provenance']) &&
    authorityBoundedJson(v, SERVICE_PLUGIN_MAX_DISCOVERY_BYTES)
  );
}
export function validServiceCatalogSnapshot(v: unknown): v is ServiceCatalogSnapshot {
  if (
    !object(v) ||
    !keys(v, [
      'id',
      'connectionId',
      'configRevision',
      'trustRevision',
      'credentialRevision',
      'completeness',
      'observedAt',
      'provenance',
      'tools',
    ]) ||
    !text(v['id']) ||
    !text(v['connectionId']) ||
    !validServiceConnectionVersions(v) ||
    v['completeness'] !== 'complete' ||
    !instant(v['observedAt']) ||
    !provenance(v['provenance'])
  )
    return false;
  const tools = v['tools'];
  return (
    Array.isArray(tools) &&
    tools.length <= SERVICE_PLUGIN_MAX_TOOLS &&
    authorityDenseArray(tools) &&
    tools.every(validServiceToolDefinition) &&
    new Set(tools.map((t) => t.name)).size === tools.length &&
    authorityBoundedJson(v, SERVICE_PLUGIN_MAX_DISCOVERY_BYTES)
  );
}
