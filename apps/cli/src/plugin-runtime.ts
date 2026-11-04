/**
 * Shared service-plugin composition.
 *
 * One place builds the durable owner API (catalog, connections, grants), the
 * admission service, the granted-tool source and the durable operation views
 * over the runtime's authoritative SQLite stores. The transport arrives from
 * the host: when absent or unqualified, execution stays fail-closed and normal
 * chat behavior is exactly the plugin-disabled behavior.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  SHIPPED_PLUGIN_CATALOG,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  type PluginAdapterIdentity,
  type PluginCatalog,
} from '@runnets/domain';
import {
  PluginAccessService,
  PluginCallAdmissionService,
  PluginCatalogService,
  PluginConnectionService,
  PluginOperationsService,
  PluginToolService,
  pluginAdapterIdentityFrom,
  ServicePluginDiscoveryRefusedError,
  type PluginAccessStorePort,
  type PluginAdmissionStorePort,
  type PluginCatalogStorePort,
  type PluginConnectionStorePort,
  type PluginCredentialReferencePort,
  type PluginOperationStorePort,
  type ServicePluginInvokeOutcome,
  type ServicePluginTransportPort,
} from '@runnets/application';
import type { Clock } from '@runnets/application';
import {
  createEnvironmentCredentialReferences,
  createPluginInstallStore,
} from '@runnets/tools-node';

/** Ocean's adapter protocol identity; the SDK version comes from the transport. */
export const PLUGIN_PROTOCOL = {
  adapter: 'runnets-executor',
  protocolVersion: 1,
  manifestSchemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
} as const;

/** Fail-closed default: no SDK import, no host, no network request. */
export class DisabledPluginTransport implements ServicePluginTransportPort {
  readonly sessions = { ready: () => false, current: () => false, publish: () => false };
  readonly #reason: string;
  constructor(reason = 'execution_disabled') {
    this.#reason = reason;
  }
  qualification() {
    return {
      qualified: false,
      reason: this.#reason,
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

export interface PluginRuntimeStores {
  readonly catalog: PluginCatalogStorePort;
  readonly connections: PluginConnectionStorePort;
  readonly access: PluginAccessStorePort;
  readonly admission?: PluginAdmissionStorePort;
  readonly operations?: PluginOperationStorePort;
}

export interface ComposePluginRuntimeOptions {
  readonly profile: string;
  readonly stores: PluginRuntimeStores;
  readonly clock: Clock;
  readonly restored: boolean;
  readonly mutationsAllowed?: boolean;
  readonly transport?: ServicePluginTransportPort | undefined;
  readonly credentials?: PluginCredentialReferencePort | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly catalog?: PluginCatalog | undefined;
}

export interface PluginOwnerServices {
  readonly catalog: PluginCatalogService;
  readonly connections: PluginConnectionService;
  readonly access: PluginAccessService;
}

export class PluginRuntime {
  readonly services: PluginOwnerServices;
  readonly transport: ServicePluginTransportPort;
  readonly adapter: PluginAdapterIdentity;
  /** True only when the transport reported a qualified pinned adapter. */
  readonly qualified: boolean;
  readonly admission: PluginCallAdmissionService | null;
  readonly tools: PluginToolService | null;
  readonly operations: PluginOperationsService | null;
  readonly mutationsAllowed: boolean;

  constructor(input: {
    readonly services: PluginOwnerServices;
    readonly transport: ServicePluginTransportPort;
    readonly adapter: PluginAdapterIdentity;
    readonly qualified: boolean;
    readonly admission: PluginCallAdmissionService | null;
    readonly tools: PluginToolService | null;
    readonly operations: PluginOperationsService | null;
    readonly mutationsAllowed: boolean;
  }) {
    this.services = input.services;
    this.transport = input.transport;
    this.adapter = input.adapter;
    this.qualified = input.qualified;
    this.admission = input.admission;
    this.tools = input.tools;
    this.operations = input.operations;
    this.mutationsAllowed = input.mutationsAllowed;
  }

  /** Close the adapter host when the transport owns one. Never throws. */
  async shutdown(): Promise<void> {
    const close = (this.transport as { close?: () => Promise<void> }).close;
    if (typeof close !== 'function') return;
    try {
      await close.call(this.transport);
    } catch {
      /* A failed adapter close is reported by the host drain, never silently claimed. */
    }
  }
}

/** Compose the shared plugin services over one authoritative store set. */
export function composePluginRuntime(options: ComposePluginRuntimeOptions): PluginRuntime {
  const time = () => new Date(options.clock.now());
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const restored = options.restored;
  const mutationsAllowed = options.mutationsAllowed ?? restored !== true;
  const context = {
    clock: options.clock,
    // The pinned SDK only preserves connection names matching
    // `^[a-z][A-Za-z0-9]*$`; a leading digit/underscore is silently rewritten, so
    // Ocean generates SDK-stable ids that address the exact durable row.
    nextId: () => 'p' + randomUUID().replaceAll('-', ''),
    sha256,
    restored,
    mutationsAllowed,
  };
  const files = createPluginInstallStore({ profile: options.profile });
  files.sweepInterrupted();
  const transport = options.transport ?? new DisabledPluginTransport();
  const qualifiedAdapter = pluginAdapterIdentityFrom(transport.qualification(), PLUGIN_PROTOCOL);
  const catalogCard = options.catalog ?? SHIPPED_PLUGIN_CATALOG;
  const adapter =
    qualifiedAdapter ?? (catalogCard.entries[0]?.adapter as PluginAdapterIdentity | undefined);
  if (adapter === undefined) throw Error('plugin_catalog_empty');
  const catalog = new PluginCatalogService({
    catalog: catalogCard,
    store: options.stores.catalog,
    files,
    adapter,
    ...context,
  });
  catalog.initialize();
  const credentials =
    options.credentials ?? createEnvironmentCredentialReferences(options.env ?? process.env);
  const connections = new PluginConnectionService({
    store: options.stores.connections,
    versions: catalog,
    transport,
    credentials,
    adapter,
    ...context,
  });
  connections.initialize();
  const access = new PluginAccessService({ store: options.stores.access, transport, ...context });
  const admission =
    options.stores.admission === undefined
      ? null
      : new PluginCallAdmissionService({
          store: options.stores.admission,
          transport,
          credentials,
          adapter,
          now: () => time().toISOString(),
          sha256,
        });
  const tools =
    admission === null
      ? null
      : new PluginToolService({
          grants: options.stores.access,
          connections: options.stores.connections,
          admission,
          transport,
        });
  const operations =
    options.stores.operations === undefined
      ? null
      : new PluginOperationsService({
          store: options.stores.operations,
          clock: options.clock,
          restored,
          mutationsAllowed,
        });
  return new PluginRuntime({
    services: { catalog, connections, access },
    transport,
    adapter,
    qualified: qualifiedAdapter !== null,
    admission,
    tools,
    operations,
    mutationsAllowed,
  });
}
