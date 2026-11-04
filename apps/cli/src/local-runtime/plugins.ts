/**
 * Owner API over the authenticated runtime socket.
 *
 * Catalog, named-connection references, exact grants and the durable operation
 * journal cross this wire as metadata only: a connection exposes the
 * environment variable NAME, never a credential value.
 */

import { PluginRefusedError } from '@runnets/application';
import type {
  PluginAccessService,
  PluginCatalogService,
  PluginConnectionService,
  PluginOperationsService,
} from '@runnets/application';
import {
  isLocalPluginCatalogQuery,
  isLocalPluginConnectionAddRequest,
  isLocalPluginConnectionQuery,
  isLocalPluginConnectionRequest,
  isLocalPluginGrantFilter,
  isLocalPluginGrantRequest,
  isLocalPluginInspectQuery,
  isLocalPluginInstallRequest,
  isLocalPluginRevokeRequest,
} from '@runnets/contracts';
import {
  isLocalPluginOperationAcknowledgeRequest,
  isLocalPluginOperationListQuery,
  isLocalPluginOperationQuery,
} from '@runnets/contracts';
import type { RuntimeReply } from './queries.js';

export interface RuntimePluginsServices {
  readonly catalog: PluginCatalogService;
  readonly connections: PluginConnectionService;
  readonly access: PluginAccessService;
  readonly operations: PluginOperationsService | null;
}

/** Owner API over the authenticated socket; replies are metadata only. */
export class RuntimePlugins {
  readonly #services: RuntimePluginsServices;
  /** A stop must never report `complete` while an owner discovery/consent is discarded. */
  #draining = false;
  readonly #inFlight = new Set<Promise<RuntimeReply>>();
  constructor(services: RuntimePluginsServices) {
    this.#services = services;
  }
  get services(): RuntimePluginsServices {
    return this.#services;
  }
  dispatch(method: string, params: Record<string, unknown>): RuntimeReply | Promise<RuntimeReply> {
    const { catalog, connections, access, operations } = this.#services;
    switch (method) {
      case 'plugin.catalog': {
        if (!isLocalPluginCatalogQuery(params)) return invalid();
        const search = params['search'];
        return { result: catalog.search(typeof search === 'string' ? search : undefined) };
      }
      case 'plugin.inspect': {
        if (!isLocalPluginInspectQuery(params)) return invalid();
        const query = params;
        return this.#supervise(() => catalog.inspect(query.pluginId));
      }
      case 'plugin.install': {
        if (!isLocalPluginInstallRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => catalog.install(request));
      }
      case 'plugin.repair': {
        if (!isLocalPluginInstallRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => catalog.repair(request));
      }
      case 'plugin.enable': {
        if (!isLocalPluginInstallRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => catalog.enable(request));
      }
      case 'plugin.disable': {
        if (!isLocalPluginInspectQuery(params)) return invalid();
        const request = params;
        return this.#supervise(() => catalog.disable(request));
      }
      case 'plugin.connections':
        return { result: connections.list() };
      case 'plugin.connection-add': {
        if (!isLocalPluginConnectionAddRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => connections.add(request));
      }
      case 'plugin.connection-preview': {
        if (!isLocalPluginConnectionQuery(params)) return invalid();
        const query = params;
        return this.#supervise(() => connections.consentPreview(query.connectionId));
      }
      case 'plugin.connection-consent': {
        if (!isLocalPluginConnectionRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => {
          connections.consent(request);
          return connections.consentPreview(request.connectionId);
        });
      }
      case 'plugin.connection-discover': {
        if (!isLocalPluginConnectionRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => connections.discover(request));
      }
      case 'plugin.connection-disconnect': {
        if (!isLocalPluginConnectionQuery(params)) return invalid();
        const query = params;
        return this.#supervise(() => connections.disconnect(query.connectionId));
      }
      case 'plugin.access-list': {
        if (!isLocalPluginGrantFilter(params)) return invalid();
        const filter = params;
        return { result: access.list(filter) };
      }
      case 'plugin.access-preview': {
        if (!isLocalPluginGrantRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => access.preview(request));
      }
      case 'plugin.access-grant': {
        if (!isLocalPluginGrantRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => access.grant(request));
      }
      case 'plugin.access-revoke': {
        if (!isLocalPluginRevokeRequest(params)) return invalid();
        const request = params;
        return this.#supervise(() => access.revoke(request.grantId));
      }
      case 'plugin.operations-list': {
        if (operations === null || !isLocalPluginOperationListQuery(params)) return invalid();
        const query = params;
        return { result: operations.list(query) };
      }
      case 'plugin.operation-show': {
        if (!isLocalPluginOperationQuery(params)) return invalid();
        return this.#run(() => requireOperations(operations).show(params.operationId));
      }
      case 'plugin.operation-acknowledge': {
        if (operations === null || !isLocalPluginOperationAcknowledgeRequest(params))
          return invalid();
        const request = params;
        return this.#run(() => requireOperations(operations).acknowledge(request));
      }
      default:
        return invalid();
    }
  }
  /** Track one asynchronous owner mutation until its persisted effect is settled. */
  #supervise(run: () => unknown): Promise<RuntimeReply> {
    if (this.#draining) return Promise.resolve({ error: { code: 'runtime_draining' } });
    const job = this.#run(run);
    this.#inFlight.add(job);
    void job.finally(() => this.#inFlight.delete(job));
    return job;
  }
  async #run(run: () => unknown): Promise<RuntimeReply> {
    try {
      return { result: await run() };
    } catch (error) {
      if (error instanceof PluginRefusedError) return { error: { code: error.code } };
      if (error instanceof Error && /^[a-z_]+$/.test(error.message))
        return { error: { code: error.message } };
      if (error instanceof Error && error.name === 'ServicePluginDiscoveryRefusedError')
        return { error: { code: error.message.slice(0, 64) } };
      return { error: { code: 'plugin_failed' } };
    }
  }
  /** Refuse new owner mutations and await every in-flight install/discovery/grant. */
  async drain(): Promise<'settled'> {
    this.#draining = true;
    await Promise.all(this.#inFlight);
    return 'settled';
  }
}

function requireOperations(operations: PluginOperationsService | null): PluginOperationsService {
  if (operations === null) throw new PluginRefusedError('operations_unavailable', 'unavailable');
  return operations;
}

function invalid(): RuntimeReply {
  return { error: { code: 'invalid_params' } };
}
