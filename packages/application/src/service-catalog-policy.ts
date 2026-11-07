import {
  canonicalJson,
  type OwnerPermission,
  type ServiceConnection,
  type ServiceCatalogSnapshot,
  type ServiceToolDefinition,
} from '@runnets/domain';
import type { ServiceAuthorityTransaction } from './service-authority-ports.js';
export function currentServiceCatalog(
  tx: ServiceAuthorityTransaction,
  c: ServiceConnection,
): ServiceCatalogSnapshot | null {
  const s = c.currentCatalogId && tx.catalog(c.currentCatalogId);
  return s &&
    c.state === 'active' &&
    s.connectionId === c.id &&
    s.configRevision === c.configRevision &&
    s.trustRevision === c.trustRevision &&
    s.credentialRevision === c.credentialRevision
    ? s
    : null;
}
function definition(tool: ServiceToolDefinition) {
  return canonicalJson([
    tool.name,
    tool.description,
    tool.inputSchema,
    tool.outputSchema,
    tool.annotations,
    tool.definitionDigest,
  ]);
}
export function sameServiceTool(a: ServiceToolDefinition, b: ServiceToolDefinition): boolean {
  return definition(a) === definition(b);
}
export function eligibleServiceTool(
  permission: Extract<OwnerPermission, { kind: 'service' }>,
  baseline: ServiceCatalogSnapshot | null,
  current: ServiceCatalogSnapshot,
  tool: ServiceToolDefinition,
  credentialContinuous: boolean,
): boolean {
  if (
    permission.connectionId !== current.connectionId ||
    permission.trustRevision !== current.trustRevision ||
    !baseline ||
    baseline.connectionId !== current.connectionId ||
    baseline.trustRevision !== current.trustRevision ||
    (baseline.credentialRevision !== current.credentialRevision && !credentialContinuous)
  )
    return false;
  const approved = baseline.tools.find((t) => t.name === tool.name);
  if (permission.tools.kind === 'all-including-future')
    return !approved || sameServiceTool(approved, tool);
  return (
    permission.tools.names.includes(tool.name) && !!approved && sameServiceTool(approved, tool)
  );
}
/** Start a refresh by invalidating the old tuple. A failed discovery leaves history inert. */
export function beginServiceCatalogRefresh(
  tx: ServiceAuthorityTransaction,
  id: string,
): ServiceConnection {
  const c = tx.connection(id);
  if (!c || c.state !== 'active' || c.trust.metadataPermission !== 'allow')
    throw Error('metadata_permission_required');
  const fresh = { ...c, configRevision: c.configRevision + 1 };
  if (!tx.putConnection(fresh, c)) throw Error('catalog_stale');
  return fresh;
}
export function publishServiceCatalogRefresh(
  tx: ServiceAuthorityTransaction,
  s: ServiceCatalogSnapshot,
): boolean {
  const c = tx.connection(s.connectionId);
  if (
    !c ||
    c.state !== 'active' ||
    c.trust.metadataPermission !== 'allow' ||
    s.configRevision !== c.configRevision ||
    s.trustRevision !== c.trustRevision ||
    s.credentialRevision !== c.credentialRevision
  )
    return false;
  return tx.putCatalog(s) && tx.publishCatalog(c.id, c, s.id);
}
