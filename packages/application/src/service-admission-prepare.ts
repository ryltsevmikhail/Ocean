import { utf8Length } from './plugin-json.js';
import {
  canonicalJson,
  ownerGrantApplies,
  ownerResourceIncludes,
  validEffectResourceScope,
  type OwnerPermission,
  type OwnerScopeGrant,
  type ServiceJson,
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
  const allowed = servicePermissionsAllow(
    tx,
    g.permissions,
    c,
    current,
    tool,
    facts.scope,
    options,
  );
  if (!allowed) return 'authority_denied';
  const bytes = utf8Length(canonicalJson({ name: r.tool, arguments: r.arguments }));
  if (
    bytes > Math.min(SERVICE_PLUGIN_MAX_REQUEST_BYTES, g.limits.maxEffectBytes) ||
    tx.grantCalls(r.taskRunId, g.id) + (frozen ? 0 : 1) > g.limits.maxCalls
  )
    return 'grant_limit';
  const room = tx.roomScope?.(r.taskRunId, options.now());
  if (room === false || room?.reviewer) return 'authority_denied';
  let roomBasis: ServiceJson[] | undefined;
  let confirmationRequired = g.mode === 'confirm';
  if (room) {
    const own = room.subjects[0];
    if (
      room.attemptId !== r.attemptId ||
      !own ||
      canonicalJson(own.subject) !==
        canonicalJson({
          workspaceId: r.workspaceId,
          roomId: r.roomId,
          botId: r.botId,
          projectId: r.projectId,
          taskId: r.taskId,
        }) ||
      !own.refs.some((ref) => ref.grantId === g.id && ref.revision === g.revision) ||
      !servicePermissionsAllow(
        tx,
        room.root.rootPayload.mandate.permissions,
        c,
        current,
        tool,
        facts.scope,
        options,
      )
    )
      return 'authority_denied';
    roomBasis = [];
    for (const issuer of room.subjects) {
      if (!issuer.chargedRunId) return 'authority_denied';
      const candidates = issuer.refs
        .map((ref) => tx.grant(ref.grantId))
        .filter(
          (grant): grant is OwnerScopeGrant =>
            !!grant &&
            grant.owner.ownerId === c.trust.ownerId &&
            servicePermissionsAllow(
              tx,
              grant.permissions,
              c,
              current,
              tool,
              facts.scope,
              options,
            ) &&
            bytes <= grant.limits.maxEffectBytes &&
            tx.grantCalls(issuer.chargedRunId!, grant.id) + (frozen ? 0 : 1) <=
              grant.limits.maxCalls,
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.revision - b.revision));
      if (!candidates.length) return 'authority_denied';
      for (const grant of candidates) {
        confirmationRequired ||= grant.mode === 'confirm';
        roomBasis.push({
          chargedRunId: issuer.chargedRunId,
          subject: { ...issuer.subject },
          grantId: grant.id,
          revision: grant.revision,
        });
      }
    }
  }
  const admission: ToolEffectAdmission = {
    scope: facts.scope,
    effectKind: facts.effectKind,
    grantReference: r.grantReference,
    binding: {
      ...(roomBasis ? { roomBasis } : {}),
      ...(facts.managedWorkspace
        ? {
            managedWorkspace: { ...facts.managedWorkspace },
            managedEnrollment: facts.managedEnrollment!,
            managedSession: facts.managedSession!,
          }
        : {}),
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
    confirmationRequired,
  };
}

/** Shared complete action/catalog/resource eligibility; no union of partial permissions. */
export function servicePermissionsAllow(
  tx: ServiceAuthorityTransaction,
  permissions: readonly OwnerPermission[],
  c: ServiceConnection,
  current: ServiceCatalogSnapshot,
  tool: ServiceToolDefinition,
  scope: ToolEffectAdmission['scope'],
  options: ServiceCallAdmissionOptions,
): boolean {
  return permissions.some((p) => {
    if (p.kind !== 'service' || !p.baselineCatalogId || !permittedResources(p, c, scope))
      return false;
    const baseline = tx.catalog(p.baselineCatalogId);
    const continuous =
      !!baseline &&
      baseline.credentialRevision !== current.credentialRevision &&
      options.credentialContinuous?.(structuredClone(c), structuredClone(baseline)) === true;
    return eligibleServiceTool(p, baseline, current, tool, continuous);
  });
}
