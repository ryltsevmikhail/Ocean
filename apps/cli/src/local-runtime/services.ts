import type { ServiceOwnerSettings } from '@runnets/application';
import {
  isLocalServiceQuery,
  isLocalServiceReceiptQuery,
  isLocalServiceConnectionRequest,
  isLocalServiceConnectionSetRequest,
  isLocalServiceGrantSetRequest,
  isLocalServiceGrantRevokeRequest,
} from '@runnets/contracts';
import type { RuntimeReply } from './queries.js';
const codes = new Set([
  'request_conflict',
  'connection_conflict',
  'grant_conflict',
  'catalog_stale',
  'tool_unknown',
  'invalid_owner_scope',
  'invalid_owner_intent',
  'invalid_owner_permission',
  'invalid_params',
  'metadata_permission_required',
  'metadata_unavailable',
  'service_settings_unavailable',
  'insecure_permissions',
  'provider_write_failed',
]);
/** Socket lifecycle supervises owner work separately from business invocation admission. */
export class RuntimeServiceSettings {
  readonly #service: ServiceOwnerSettings;
  readonly #jobs = new Set<Promise<RuntimeReply>>();
  #draining = false;
  constructor(service: ServiceOwnerSettings) {
    this.#service = service;
  }
  dispatch(
    method: string,
    params: Record<string, unknown>,
    detached: AbortSignal,
  ): RuntimeReply | Promise<RuntimeReply> {
    const s = this.#service;
    let work: () => unknown;
    switch (method) {
      case 'service.connections':
        if (!isLocalServiceQuery(params)) return this.#invalid();
        work = () => s.connections();
        break;
      case 'service.grants':
        if (!isLocalServiceQuery(params)) return this.#invalid();
        work = () => s.grants();
        break;
      case 'service.receipt':
        if (!isLocalServiceReceiptQuery(params)) return this.#invalid();
        work = () => s.receipt(params.requestId);
        break;
      case 'service.connection-set':
        if (!isLocalServiceConnectionSetRequest(params)) return this.#invalid();
        work = () => s.setConnection(params);
        break;
      case 'service.connection-disconnect':
        if (!isLocalServiceConnectionRequest(params)) return this.#invalid();
        work = () => s.disconnect(params);
        break;
      case 'service.connection-refresh':
        if (!isLocalServiceConnectionRequest(params)) return this.#invalid();
        work = () => s.refreshConnection(params, detached);
        break;
      case 'service.grant-set':
        if (!isLocalServiceGrantSetRequest(params)) return this.#invalid();
        work = () => s.setGrant(params);
        break;
      case 'service.grant-revoke':
        if (!isLocalServiceGrantRevokeRequest(params)) return this.#invalid();
        work = () => s.revokeGrant(params);
        break;
      default:
        return this.#invalid();
    }
    if (
      this.#draining &&
      !['service.connections', 'service.grants', 'service.receipt'].includes(method)
    )
      return { error: { code: 'runtime_draining' } };
    const job = this.#run(work);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job));
    return job;
  }
  #invalid(): RuntimeReply {
    return { error: { code: 'invalid_params' } };
  }
  async #run(work: () => unknown): Promise<RuntimeReply> {
    try {
      return { result: await work() };
    } catch (error) {
      return {
        error: {
          code:
            error instanceof Error && codes.has(error.message)
              ? error.message
              : 'service_settings_failed',
        },
      };
    }
  }
  async drain(): Promise<'settled'> {
    this.#draining = true;
    await Promise.all(this.#jobs);
    return 'settled';
  }
}
