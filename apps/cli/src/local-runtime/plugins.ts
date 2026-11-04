/**
 * Host composition for plugin catalog, connections and exact grants.
 *
 * Ocean owns all plugin state; the Executor transport is injected and remains
 * disabled by default. The composed services only ever see plain metadata and
 * environment variable NAMES. Credential values are resolved inside the future
 * transport host and never cross this module.
 */

import {
  PluginAccessService,
  PluginCatalogService,
  PluginConnectionService,
  PluginRefusedError,
  ServicePluginDiscoveryRefusedError,
  type PluginAccessStorePort,
  type PluginCatalogStorePort,
  type PluginConnectionStorePort,
  type PluginCredentialReferencePort,
  type ServicePluginInvokeOutcome,
  type ServicePluginTransportPort,
} from '@runnets/application';
import { SHIPPED_PLUGIN_CATALOG, type PluginAdapterIdentity } from '@runnets/domain';
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
  createEnvironmentCredentialReferences,
  createPluginInstallStore,
} from '@runnets/tools-node';
import { randomUUID, createHash } from 'node:crypto';
import type { RuntimeReply } from './queries.js';

/** Adapter build identity this host was qualified against (Task 4 pinned identities). */
export const PLUGIN_ADAPTER_IDENTITY: PluginAdapterIdentity = {
  adapter: 'runnets-executor',
  protocolVersion: 1,
  sdkVersion: '1.6.11',
  manifestSchemaVersion: 1,
};

/** Fail-closed default: no SDK import, no host, no network request. */
class DisabledPluginTransport implements ServicePluginTransportPort {
  qualification() {
    return {
      qualified: false,
      reason: 'execution_disabled',
      identities: { 'plugin-transport': 'disabled' },
    } as const;
  }
  discover(): Promise<never> {
    return Promise.reject(
      new ServicePluginDiscoveryRefusedError(
        'execution_disabled',
        'service plugin execution is disabled in this build',
      ),
    );
  }
  invoke(): Promise<ServicePluginInvokeOutcome> {
    return Promise.resolve({
      kind: 'not_started',
      invocationId: '',
      code: 'execution_disabled',
      detail: 'service plugin execution is disabled in this build',
    });
  }
}

export interface PluginHostStores {
  readonly catalog: PluginCatalogStorePort;
  readonly connections: PluginConnectionStorePort;
  readonly access: PluginAccessStorePort;
}

export interface RuntimePluginHostOptions {
  readonly profile: string;
  readonly stores: PluginHostStores;
  readonly restored: boolean;
  readonly mutationsAllowed?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: (() => number) | undefined;
  /** Test-only deterministic transport; production omits it and stays disabled. */
  readonly transport?: ServicePluginTransportPort;
  readonly credentials?: PluginCredentialReferencePort;
  readonly adapter?: PluginAdapterIdentity;
}

export interface PluginServices {
  readonly catalog: PluginCatalogService;
  readonly connections: PluginConnectionService;
  readonly access: PluginAccessService;
}

export function runtimePluginsHost(options: RuntimePluginHostOptions): RuntimePlugins {
  const time = () => new Date(options.now?.() ?? Date.now());
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const context = {
    clock: { now: time },
    nextId: () => randomUUID().replaceAll('-', ''),
    sha256,
    restored: options.restored,
    mutationsAllowed: options.mutationsAllowed ?? options.restored !== true,
  };
  const files = createPluginInstallStore({ profile: options.profile });
  // Interrupted temp publications are inert; drop only this store's own leftovers.
  files.sweepInterrupted();
  const catalog = new PluginCatalogService({
    catalog: SHIPPED_PLUGIN_CATALOG,
    store: options.stores.catalog,
    files,
    adapter: options.adapter ?? PLUGIN_ADAPTER_IDENTITY,
    ...context,
  });
  catalog.initialize();
  const connections = new PluginConnectionService({
    store: options.stores.connections,
    versions: catalog,
    transport: options.transport ?? new DisabledPluginTransport(),
    credentials:
      options.credentials ?? createEnvironmentCredentialReferences(options.env ?? process.env),
    adapter: options.adapter ?? PLUGIN_ADAPTER_IDENTITY,
    ...context,
  });
  connections.initialize();
  const access = new PluginAccessService({ store: options.stores.access, ...context });
  return new RuntimePlugins({ catalog, connections, access });
}

export interface RuntimePluginsServices {
  readonly catalog: PluginCatalogService;
  readonly connections: PluginConnectionService;
  readonly access: PluginAccessService;
}

/** Owner API over the authenticated socket; replies are metadata only. */
export class RuntimePlugins {
  readonly #services: RuntimePluginsServices;
  constructor(services: RuntimePluginsServices) {
    this.#services = services;
  }
  get services(): RuntimePluginsServices {
    return this.#services;
  }
  dispatch(method: string, params: Record<string, unknown>): RuntimeReply | Promise<RuntimeReply> {
    const { catalog, connections, access } = this.#services;
    switch (method) {
      case 'plugin.catalog': {
        if (!isLocalPluginCatalogQuery(params)) return invalid();
        const search = params['search'];
        return { result: catalog.search(typeof search === 'string' ? search : undefined) };
      }
      case 'plugin.inspect': {
        if (!isLocalPluginInspectQuery(params)) return invalid();
        const query = params;
        return this.#run(() => catalog.inspect(query.pluginId));
      }
      case 'plugin.install': {
        if (!isLocalPluginInstallRequest(params)) return invalid();
        const request = params;
        return this.#run(() => catalog.install(request));
      }
      case 'plugin.repair': {
        if (!isLocalPluginInstallRequest(params)) return invalid();
        const request = params;
        return this.#run(() => catalog.repair(request));
      }
      case 'plugin.enable': {
        if (!isLocalPluginInstallRequest(params)) return invalid();
        const request = params;
        return this.#run(() => catalog.enable(request));
      }
      case 'plugin.disable': {
        if (!isLocalPluginInspectQuery(params)) return invalid();
        const request = params;
        return this.#run(() => catalog.disable(request));
      }
      case 'plugin.connections':
        return { result: connections.list() };
      case 'plugin.connection-add': {
        if (!isLocalPluginConnectionAddRequest(params)) return invalid();
        const request = params;
        return this.#run(() => connections.add(request));
      }
      case 'plugin.connection-preview': {
        if (!isLocalPluginConnectionQuery(params)) return invalid();
        const query = params;
        return this.#run(() => connections.consentPreview(query.connectionId));
      }
      case 'plugin.connection-consent': {
        if (!isLocalPluginConnectionRequest(params)) return invalid();
        const request = params;
        return this.#run(() => {
          connections.consent(request);
          return connections.consentPreview(request.connectionId);
        });
      }
      case 'plugin.connection-discover': {
        if (!isLocalPluginConnectionRequest(params)) return invalid();
        const request = params;
        return this.#run(() => connections.discover(request));
      }
      case 'plugin.connection-disconnect': {
        if (!isLocalPluginConnectionQuery(params)) return invalid();
        const query = params;
        return this.#run(() => connections.disconnect(query.connectionId));
      }
      case 'plugin.access-list': {
        if (!isLocalPluginGrantFilter(params)) return invalid();
        const filter = params;
        return { result: access.list(filter) };
      }
      case 'plugin.access-preview': {
        if (!isLocalPluginGrantRequest(params)) return invalid();
        const request = params;
        return this.#run(() => access.preview(request));
      }
      case 'plugin.access-grant': {
        if (!isLocalPluginGrantRequest(params)) return invalid();
        const request = params;
        return this.#run(() => access.grant(request));
      }
      case 'plugin.access-revoke': {
        if (!isLocalPluginRevokeRequest(params)) return invalid();
        const request = params;
        return this.#run(() => access.revoke(request.grantId));
      }
      default:
        return invalid();
    }
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
}

function invalid(): RuntimeReply {
  return { error: { code: 'invalid_params' } };
}
