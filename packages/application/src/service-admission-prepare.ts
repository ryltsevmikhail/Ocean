import { utf8Length } from './plugin-json.js';
import {
  canonicalJson,
  ownerGrantApplies,
  ownerResourceIncludes,
  validEffectResourceScope,
  type OwnerPermission,
  type ServiceConnection,
  type ServiceCatalogSnapshot,
  type ServiceToolDefinition,
  type ToolEffectAdmission,
} from '@runnets/domain';
import type { ServiceAuthorityTransaction } from './service-authority-ports.js';
import {
  currentServiceCatalog,
  eligibleServiceTool,
  sameServiceTool,
} from './service-catalog-policy.js';
import type { ServiceCallAdmissionOptions, ServiceCallRequest } from './service-admission-types.js';
import { SERVICE_PLUGIN_MAX_REQUEST_BYTES } from './service-plugin-transport.js';
export interface Prepared {
  connection: ServiceConnection;
  catalog: ServiceCatalogSnapshot;
  tool: ServiceToolDefinition;
  admission: ToolEffectAdmission;
  confirmationRequired: boolean;
}
function permittedResources(
  p: Extract<OwnerPermission, { kind: 'service' }>,
  c: ServiceConnection,
  scope: ToolEffectAdmission['scope'],
): boolean {
  if (scope.kind === 'legacy-global-unknown')
    return p.resources.some((r) => r.kind === 'connection' && r.connectionId === c.id);
  return scope.resources.every((actual) => {
    if (actual.kind === 'project-worktree' || actual.connectionId !== c.id) return false;
    if (!p.resources.some((r) => ownerResourceIncludes(r, actual))) return false;
    if (actual.kind === 'connection') return true;
    return (
      c.trust.identity.status === 'verified' &&
      c.trust.identity.accountId === actual.accountId &&
      c.trust.resourceEnforcement.some(
        (e) => e.status === 'evidenced' && ownerResourceIncludes(e.scope, actual),
      )
    );
  });
}
export function prepare(
  tx: ServiceAuthorityTransaction,
  r: ServiceCallRequest,
  options: ServiceCallAdmissionOptions,
  frozen?: Prepared,
): Prepared | string {
  if (options.restored) return 'recovery_required';
  const g = tx.grant(r.grantReference.grantId),
    c = tx.connection(r.connectionId);
  if (
    !g ||
    g.revision !== r.grantReference.revision ||
    !ownerGrantApplies(g, r, options.now()) ||
    !tx.participates(r) ||
    !tx.runMatches(r)
  )
    return 'authority_denied';
  if (!c || g.owner.ownerId !== c.trust.ownerId) return 'authority_denied';
  const current = currentServiceCatalog(tx, c);
  if (!current || (!frozen && current.id !== r.catalogId)) return 'catalog_stale';
  const tool = current.tools.find((t) => t.name === r.tool);
  if (!tool) return 'tool_unknown';
  if (frozen && !sameServiceTool(frozen.tool, tool)) return 'catalog_stale';
  const facts = options.classify?.(
    structuredClone(c),
    structuredClone(tool),
    structuredClone(r.arguments),
  ) ?? { scope: { kind: 'legacy-global-unknown' as const }, effectKind: 'mutation' as const };
  if (
    !validEffectResourceScope(facts.scope) ||
    !['mutation', 'observation'].includes(facts.effectKind)
  )
    return 'authority_denied';
  const allowed = g.permissions.some((p) => {
    if (p.kind !== 'service' || !p.baselineCatalogId || !permittedResources(p, c, facts.scope))
      return false;
    const baseline = tx.catalog(p.baselineCatalogId);
    const continuous =
      !!baseline &&
      baseline.credentialRevision !== current.credentialRevision &&
      options.credentialContinuous?.(structuredClone(c), structuredClone(baseline)) === true;
    return eligibleServiceTool(p, baseline, current, tool, continuous);
  });
  if (!allowed) return 'authority_denied';
  const bytes = utf8Length(canonicalJson({ name: r.tool, arguments: r.arguments }));
  if (
    bytes > Math.min(SERVICE_PLUGIN_MAX_REQUEST_BYTES, g.limits.maxEffectBytes) ||
    tx.grantCalls(r.taskRunId, g.id) + (frozen ? 0 : 1) > g.limits.maxCalls
  )
    return 'grant_limit';
  const admission: ToolEffectAdmission = {
    scope: facts.scope,
    effectKind: facts.effectKind,
    grantReference: r.grantReference,
    binding: {
      ...(facts.githubRepositoryIds ? { githubRepositoryIds: facts.githubRepositoryIds } : {}),
      workspaceId: r.workspaceId,
      roomId: r.roomId,
      botId: r.botId,
      taskId: r.taskId,
      projectId: r.projectId,
      connectionId: c.id,
      catalogId: r.catalogId,
      configRevision: c.configRevision,
      trustRevision: c.trustRevision,
      credentialRevision: c.credentialRevision,
      tool: tool.name,
      definitionDigest: tool.definitionDigest,
      payloadBytes: bytes,
    },
  };
  return {
    connection: c,
    catalog: current,
    tool,
    admission,
    confirmationRequired: g.mode === 'confirm',
  };
}
