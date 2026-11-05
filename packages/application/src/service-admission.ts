import { utf8Length } from './plugin-json.js';
import {
  canonicalJson,
  effectResourcesConflict,
  ownerGrantApplies,
  ownerResourceIncludes,
  validServiceJson,
  validOwnerGrantReference,
  validEffectResourceScope,
  validConversationText,
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
import type {
  ServiceCallAdmissionOptions,
  ServiceCallRequest,
  ServiceCallResult,
} from './service-admission-types.js';
import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  SERVICE_PLUGIN_MAX_REQUEST_BYTES,
  type ServicePluginInvokeOutcome,
} from './service-plugin-transport.js';
interface Prepared {
  connection: ServiceConnection;
  catalog: ServiceCatalogSnapshot;
  tool: ServiceToolDefinition;
  admission: ToolEffectAdmission;
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
function prepare(
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
  if (g.mode === 'confirm') return 'confirmation_required';
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
  return { connection: c, catalog: current, tool, admission };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export class ServiceCallAdmissionService {
  private readonly options: ServiceCallAdmissionOptions;
  constructor(options: ServiceCallAdmissionOptions) {
    this.options = options;
  }
  async call(request: ServiceCallRequest, signal?: AbortSignal): Promise<ServiceCallResult> {
    let r: ServiceCallRequest;
    try {
      r = structuredClone(request);
    } catch {
      return { code: 'invalid_request', outcome: null };
    }
    if (
      !r ||
      typeof r !== 'object' ||
      Object.keys(r).some(
        (k) =>
          ![
            'workspaceId',
            'roomId',
            'botId',
            'projectId',
            'taskId',
            'connectionId',
            'catalogId',
            'tool',
            'arguments',
            'grantReference',
            'taskRunId',
            'attemptId',
            'invocationId',
          ].includes(k),
      ) ||
      ![r.workspaceId, r.roomId, r.botId].every((id) => validConversationText(id, 128)) ||
      ![r.projectId, r.taskId].every((id) => id === null || validConversationText(id, 128)) ||
      !validOwnerGrantReference(r.grantReference) ||
      !validServiceJson(r.arguments) ||
      ![r.taskRunId, r.attemptId, r.invocationId, r.tool, r.connectionId, r.catalogId].every(
        (s) => typeof s === 'string' && validConversationText(s, 128),
      )
    )
      return { code: 'invalid_request', outcome: null };
    if (signal?.aborted) return { code: 'cancelled', outcome: null };
    const ms = this.options.deadlineMs ?? SERVICE_PLUGIN_CALL_DEADLINE_MS;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2147483647)
      return { code: 'invalid_deadline', outcome: null };
    const prepared = this.options.store.atomic((tx) => {
      const p = prepare(tx, r, this.options);
      if (typeof p === 'string') return p;
      return tx.claim(r, canonicalJson([r, p.admission]), p.admission) ? p : 'claim_refused';
    });
    if (typeof prepared === 'string') return { code: prepared, outcome: null };
    const lifetime = new AbortController();
    let sent = false,
      closed = false;
    const expire = Date.now() + ms;
    const abort = () => lifetime.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, ms);
    const lost = (possiblySent = sent): ServicePluginInvokeOutcome =>
      possiblySent
        ? {
            kind: 'uncertain',
            invocationId: r.invocationId,
            code: 'transport_failure',
            detail: 'response unavailable after dispatch',
          }
        : {
            kind: 'not_started',
            invocationId: r.invocationId,
            code: 'execution_disabled',
            detail: 'dispatch guard did not admit the invocation',
          };
    const authorizeDispatch = () => {
      if (closed || sent || lifetime.signal.aborted || Date.now() >= expire) return false;
      try {
        const ok = this.options.store.atomic((tx) => {
          const current = prepare(tx, r, this.options, prepared);
          if (
            typeof current === 'string' ||
            canonicalJson(current.admission) !== canonicalJson(prepared.admission)
          )
            return false;
          const pending = tx.pending();
          const own = (e: (typeof pending)[number]) =>
            e.taskRunId === r.taskRunId && e.attemptId === r.attemptId && e.id === r.invocationId;
          return (
            pending.some(
              (e) =>
                own(e) &&
                e.outcome === 'started' &&
                canonicalJson(e.admission) === canonicalJson(prepared.admission),
            ) &&
            !pending.some(
              (e) => !own(e) && effectResourcesConflict(e.admission, prepared.admission),
            )
          );
        });
        if (ok && !lifetime.signal.aborted && Date.now() < expire) {
          sent = true;
          return true;
        }
      } catch {
        /* Failed authority inspection cannot permit dispatch. */
      }
      closed = true;
      return false;
    };
    let outcome: ServicePluginInvokeOutcome;
    try {
      const interrupted = new Promise<ServicePluginInvokeOutcome>((resolve) => {
        if (lifetime.signal.aborted) resolve(lost());
        else lifetime.signal.addEventListener('abort', () => resolve(lost()), { once: true });
      });
      const result = await Promise.race([
        this.options.transport.invoke({
          connection: freeze(prepared.connection),
          catalogId: prepared.catalog.id,
          definition: freeze(prepared.tool),
          arguments: freeze(r.arguments),
          invocationId: r.invocationId,
          signal: lifetime.signal,
          deadlineMs: ms,
          authorizeDispatch,
        }),
        interrupted,
      ]);
      outcome =
        result.invocationId === r.invocationId &&
        (sent ? result.kind !== 'not_started' : result.kind === 'not_started')
          ? result
          : lost(sent || result.kind !== 'not_started');
    } catch {
      outcome = lost();
    } finally {
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      abort();
    }
    const settlement =
      outcome.kind === 'observed' ? (outcome.code === 'ok' ? 'completed' : 'failed') : outcome.kind;
    this.options.store.atomic((tx) => tx.settle(r, settlement));
    return { code: outcome.code, outcome };
  }
}
