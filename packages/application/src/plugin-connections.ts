/**
 * Owner-facing plugin connection service.
 *
 * A connection is a named reference to one account on one enabled plugin. Only
 * the environment variable NAME is stored. Discovery requires an explicit owner
 * consent for the exact endpoint and connection generation; a schema digest is
 * published only from one successful complete `discover()` result and is never
 * derived from a refusal or a persisted snapshot.
 */

import { type PluginManifest } from '@runnets/domain';
import {
  ServicePluginDiscoveryRefusedError,
  type ServicePluginCatalog,
  type ServicePluginTransportPort,
} from './service-plugin-transport.js';
import {
  PluginRefusedError,
  pluginAdapterVersion,
  type PluginConnectionRecord,
  type PluginConnectionStorePort,
  type PluginCredentialReferencePort,
  type PluginServiceContext,
  type PluginVersionReadPort,
} from './plugin-ports.js';
import type { PluginAdapterIdentity } from '@runnets/domain';
import {
  pluginConnectionTarget,
  pluginSessionReady,
  reconcilePluginSession,
} from './plugin-session-authority.js';
import { publishPluginDiscovery } from './plugin-discovery-publication.js';
import {
  addPluginConnection,
  changePluginConnection,
  disconnectPluginConnection,
} from './plugin-connection-mutations.js';
import {
  pluginConnectionView,
  pluginConsentPrompt,
  type PluginAddConnectionInput,
  type PluginChangeConnectionInput,
  type PluginConnectionView,
  type PluginConsentPreview,
  type PluginDiscoveryResult,
} from './plugin-connection-views.js';

export interface PluginConnectionServiceOptions extends PluginServiceContext {
  readonly store: PluginConnectionStorePort;
  readonly versions: PluginVersionReadPort;
  readonly transport: ServicePluginTransportPort;
  readonly credentials: PluginCredentialReferencePort;
  readonly adapter: PluginAdapterIdentity;
  readonly discoveryDeadlineMs?: number;
}

export class PluginConnectionService {
  readonly #store: PluginConnectionStorePort;
  readonly #versions: PluginVersionReadPort;
  readonly #transport: ServicePluginTransportPort;
  readonly #credentials: PluginCredentialReferencePort;
  readonly #adapter: PluginAdapterIdentity;
  readonly #context: PluginServiceContext;
  readonly #discoveryDeadlineMs: number | undefined;

  constructor(options: PluginConnectionServiceOptions) {
    this.#store = options.store;
    this.#versions = options.versions;
    this.#transport = options.transport;
    this.#credentials = options.credentials;
    this.#adapter = options.adapter;
    this.#context = {
      clock: options.clock,
      nextId: options.nextId,
      sha256: options.sha256,
      ...(options.mutationsAllowed === undefined
        ? {}
        : { mutationsAllowed: options.mutationsAllowed }),
      ...(options.restored === undefined ? {} : { restored: options.restored }),
    };
    this.#discoveryDeadlineMs = options.discoveryDeadlineMs;
  }

  /** Restored profiles invalidate every connection, grant and confirmation durably. */
  initialize(): void {
    if (this.#context.restored === true) this.#store.invalidateRestored(this.#now());
    else if (this.#context.mutationsAllowed !== false) this.list();
  }

  list(): readonly PluginConnectionView[] {
    return this.#store.list().map((connection) => this.#view(connection));
  }

  get(connectionId: string): PluginConnectionView {
    return this.#view(this.#connection(connectionId));
  }

  add(input: PluginAddConnectionInput): PluginConnectionView {
    this.#mutate();
    return addPluginConnection(
      {
        store: this.#store,
        versions: this.#versions,
        adapter: this.#adapter,
        nextId: this.#context.nextId,
        now: () => this.#now(),
        view: (connection) => this.#view(connection),
      },
      input,
    );
  }

  /** Owner-visible request for metadata-discovery consent; makes no network request. */
  consentPreview(connectionId: string): PluginConsentPreview {
    const connection = this.#connection(connectionId);
    const consented =
      connection.consentedGeneration === connection.generation && connection.state === 'active';
    return {
      connectionId: connection.id,
      name: connection.name,
      pluginId: connection.pluginId,
      endpoint: connection.endpoint,
      generation: connection.generation,
      consented,
      prompt: pluginConsentPrompt(connection),
    };
  }

  consent(input: { readonly connectionId: string; readonly expectedGeneration: number }): void {
    this.#mutate();
    const connection = this.#connection(input.connectionId);
    this.#requireGeneration(connection, input.expectedGeneration);
    if (connection.state !== 'active') throw refuse('connection_disconnected');
    this.#store.consent({
      connectionId: connection.id,
      generation: connection.generation,
      endpoint: connection.endpoint,
      consentedAt: this.#now(),
      usedAt: null,
    });
  }

  /**
   * One bounded discovery pass after explicit consent. A refusal publishes
   * nothing; an incomplete catalog is never stored as an empty one.
   */
  async discover(input: {
    readonly connectionId: string;
    readonly expectedGeneration: number;
  }): Promise<PluginDiscoveryResult> {
    this.#mutate();
    const connection = this.#connection(input.connectionId);
    this.#requireGeneration(connection, input.expectedGeneration);
    if (connection.state !== 'active') throw refuse('connection_disconnected');
    const enabled = this.#versions.enabled(connection.pluginId);
    if (enabled === null) throw refuse('plugin_not_enabled');
    this.#requireEndpoint(connection, enabled.manifest);
    const adapterVersion = pluginAdapterVersion(this.#adapter);
    if (
      connection.pluginVersion !== enabled.version ||
      connection.adapterVersion !== adapterVersion
    ) {
      this.#store.change(
        connection.id,
        connection.generation,
        { pluginVersion: enabled.version, adapterVersion },
        this.#now(),
      );
      throw refuse('connection_changed');
    }
    // One explicit owner consent authorizes exactly one discovery pass. It is
    // consumed before the request so a failure cannot be retried silently.
    if (
      !this.#store.consumeConsent(
        connection.id,
        connection.generation,
        connection.endpoint,
        this.#now(),
      )
    )
      throw refuse('discovery_consent_required');
    if (!this.#credentials.available(connection.credentialReference))
      throw refuse('credential_unavailable');
    const target = pluginConnectionTarget(connection);
    let catalog: ServicePluginCatalog;
    try {
      catalog = await this.#transport.discover(target, {
        ...(this.#discoveryDeadlineMs === undefined
          ? {}
          : { deadlineMs: this.#discoveryDeadlineMs }),
      });
    } catch (error) {
      if (error instanceof ServicePluginDiscoveryRefusedError)
        throw new PluginRefusedError(error.code, 'plugin discovery refused: ' + error.code);
      throw error;
    }
    const publication = publishPluginDiscovery({
      store: this.#store,
      transport: this.#transport,
      connection,
      catalog,
      manifest: enabled.manifest,
      version: enabled.version,
      adapterVersion,
      sha256: this.#context.sha256,
      now: this.#now(),
    });
    return {
      connection: this.#view(publication.connection),
      revokedGrants: publication.revokedGrants,
      authorityChanged: publication.authorityChanged,
    };
  }

  /** Any authority-bearing change bumps the generation and revokes old grants. */
  change(input: PluginChangeConnectionInput): PluginConnectionView {
    this.#mutate();
    return changePluginConnection(
      {
        store: this.#store,
        view: (connection) => this.#view(connection),
        now: () => this.#now(),
        connection: (connectionId) => this.#connection(connectionId),
        requireGeneration: (connection, expected) => this.#requireGeneration(connection, expected),
      },
      input,
    );
  }

  /** Immediate and idempotent: admission never runs against a disconnected row. */
  disconnect(connectionId: string): { connection: PluginConnectionView; revokedGrants: number } {
    this.#mutate();
    return disconnectPluginConnection(
      {
        store: this.#store,
        view: (connection) => this.#view(connection),
        now: () => this.#now(),
        connection: (id) => this.#connection(id),
      },
      connectionId,
    );
  }

  #view(connection: PluginConnectionRecord): PluginConnectionView {
    connection = this.#reconcile(connection);
    const consented = this.#store
      .consents(connection.id)
      .some(
        (entry) =>
          entry.generation === connection.generation &&
          entry.endpoint === connection.endpoint &&
          entry.usedAt === null,
      );
    return pluginConnectionView(
      connection,
      consented,
      pluginSessionReady(this.#transport, connection),
    );
  }

  #connection(connectionId: string): PluginConnectionRecord {
    const connection = this.#store.get(connectionId);
    if (connection === null) throw refuse('connection_unknown');
    return this.#reconcile(connection);
  }

  #reconcile(connection: PluginConnectionRecord): PluginConnectionRecord {
    return this.#context.mutationsAllowed === false
      ? connection
      : reconcilePluginSession(this.#store, this.#transport, connection, this.#now());
  }

  #requireGeneration(connection: PluginConnectionRecord, expectedGeneration: number): void {
    if (connection.generation !== expectedGeneration) throw refuse('connection_changed');
  }

  #requireEndpoint(connection: PluginConnectionRecord, manifest: PluginManifest): void {
    if (connection.endpoint !== manifest.endpoint) throw refuse('endpoint_mismatch');
  }

  #mutate(): void {
    if (this.#context.mutationsAllowed === false) throw refuse('restore_restricted');
  }

  #now(): string {
    return this.#context.clock.now().toISOString();
  }
}

function refuse(code: string): PluginRefusedError {
  return new PluginRefusedError(code, 'plugin connection refused: ' + code);
}
