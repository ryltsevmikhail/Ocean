import {
  canonicalJson,
  effectResourcesConflict,
  validServiceJson,
  validOwnerGrantReference,
  validConversationText,
} from '@runnets/domain';
import type {
  ServiceCallAdmissionOptions,
  ServiceCallRequest,
  ServiceCallResult,
} from './service-admission-types.js';
import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  type ServicePluginInvokeOutcome,
} from './service-plugin-transport.js';
import { prepare } from './service-admission-prepare.js';
import { confirmedPreparation, sameConfirmation } from './service-confirmation.js';
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
    let prepared = this.options.store.atomic((tx) => {
      const p = prepare(tx, r, this.options);
      if (typeof p === 'string' || p.confirmationRequired) return p;
      return tx.claim(r, canonicalJson([r, p.admission]), p.admission, this.options.now())
        ? p
        : 'claim_refused';
    });
    if (typeof prepared === 'string') return { code: prepared, outcome: null };
    if (prepared.confirmationRequired) {
      const confirmed = await confirmedPreparation(this.options, r, prepared, signal);
      if (typeof confirmed === 'string') return { code: confirmed, outcome: null };
      prepared = this.options.store.atomic((tx) => {
        const current = confirmed(tx);
        if (typeof current === 'string') return current;
        r = current.request;
        const p = current.prepared;
        return tx.claim(r, canonicalJson([r, p.admission]), p.admission, this.options.now())
          ? p
          : 'claim_refused';
      });
      if (typeof prepared === 'string') return { code: prepared, outcome: null };
    }
    const admitted = prepared;
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
          const current = prepare(tx, r, this.options, admitted);
          if (
            typeof current === 'string' ||
            (admitted.confirmationRequired && !sameConfirmation(r, admitted, current)) ||
            canonicalJson(current.admission) !== canonicalJson(admitted.admission)
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
                canonicalJson(e.admission) === canonicalJson(admitted.admission),
            ) &&
            !pending.some(
              (e) => !own(e) && effectResourcesConflict(e.admission, admitted.admission),
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
          connection: freeze(admitted.connection),
          catalogId: admitted.catalog.id,
          definition: freeze(admitted.tool),
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
