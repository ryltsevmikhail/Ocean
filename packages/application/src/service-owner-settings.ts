import {
  canonicalJson,
  validServiceConnectionRequest,
  validServiceConnectionSetRequest,
  validServiceGrantSetRequest,
  validServiceGrantRevokeRequest,
  type ServiceConnectionRequest,
  type ServiceConnectionSetRequest,
  type ServiceGrantSetRequest,
  type ServiceGrantRevokeRequest,
  type ServiceCatalogSnapshot,
} from '@runnets/domain';
import type {
  ServiceAuthorityStorePort,
  ServiceAuthorityTransaction,
} from './service-authority-ports.js';
import type { ProviderSecretStorePort } from './provider-connection-ports.js';
import { keyDigest, validRequestId, type Sha256 } from './provider-connection-request.js';
import { currentServiceCatalog } from './service-catalog-policy.js';
import { OwnerScopeService } from './owner-scope.js';
import {
  ownedConnection,
  ownerConnectionRecord,
  assertCredentialDestination,
} from './service-owner-connections.js';
import {
  serviceOwnerReceiptView,
  type ServiceOwnerReceipt,
  type ServiceOwnerResult,
} from './service-owner-receipt.js';
export interface ServiceOwnerSettingsOptions {
  readonly store: ServiceAuthorityStorePort;
  readonly secrets: ProviderSecretStorePort;
  readonly ownerId: string;
  readonly now: () => number;
  readonly sha256: Sha256;
  readonly nextId: () => string;
  readonly writable: () => boolean;
  readonly disconnect?: (connectionId: string) => void;
  readonly refresh: (
    connectionId: string,
    signal: AbortSignal | undefined,
    complete: (tx: ServiceAuthorityTransaction, snapshot: ServiceCatalogSnapshot) => void,
  ) => Promise<ServiceCatalogSnapshot>;
}
/** Trusted owner facade. Client declarations supply neither owner identity nor account evidence. */
export class ServiceOwnerSettings {
  readonly #o: ServiceOwnerSettingsOptions;
  readonly #owner: OwnerScopeService;
  constructor(options: ServiceOwnerSettingsOptions) {
    this.#o = options;
    this.#owner = new OwnerScopeService(options.store, options.ownerId, options.now);
  }
  connections() {
    return this.#o.store.atomic((tx) =>
      this.#bounded(
        tx
          .listConnections()
          .filter((c) => c.trust.ownerId === this.#o.ownerId)
          .map((c) => ({
            ...c,
            tools: currentServiceCatalog(tx, c)?.tools.map((t) => t.name) ?? [],
          })),
      ),
    );
  }
  grants() {
    return this.#o.store.atomic((tx) =>
      this.#bounded(tx.listGrants().filter((g) => g.owner.ownerId === this.#o.ownerId)),
    );
  }
  #bounded<T>(values: readonly T[]): readonly T[] {
    const result: T[] = [];
    let size = 0;
    for (const value of values) {
      size += canonicalJson(value).length;
      if (result.length === 100 || size > 400000) break;
      result.push(value);
    }
    return result;
  }
  receipt(requestId: string) {
    validRequestId(requestId);
    return this.#o.store.atomic((tx) => {
      const r = tx.ownerReceipt(requestId);
      return r?.ownerId === this.#o.ownerId ? serviceOwnerReceiptView(r) : null;
    });
  }
  #binding(method: string, request: { requestId: string; key?: string }) {
    const { key, ...metadata } = request;
    return this.#o.sha256(
      canonicalJson([method, this.#o.ownerId, metadata, keyDigest(this.#o.sha256, key)]),
    );
  }
  #replay(tx: ServiceAuthorityTransaction, requestId: string, binding: string) {
    const r = tx.ownerReceipt(requestId);
    if (!r) return null;
    if (r.ownerId !== this.#o.ownerId || r.binding !== binding) throw Error('request_conflict');
    return r;
  }
  #assertWritable() {
    if (!this.#o.writable()) throw Error('service_settings_unavailable');
  }
  #complete(
    tx: ServiceAuthorityTransaction,
    receipt: ServiceOwnerReceipt,
    result: ServiceOwnerResult,
    prepared = false,
  ) {
    const done = { ...receipt, state: 'completed' as const, result };
    if (!tx.putOwnerReceipt(done, prepared ? 'prepared' : null)) throw Error('request_conflict');
    return serviceOwnerReceiptView(done);
  }
  #receipt(requestId: string, method: string, binding: string): ServiceOwnerReceipt {
    return {
      requestId,
      method,
      binding,
      ownerId: this.#o.ownerId,
      state: 'prepared',
      result: null,
      secretReference: null,
      expectedVersions: null,
    };
  }
  setConnection(request: ServiceConnectionSetRequest) {
    this.#assertWritable();
    if (!validServiceConnectionSetRequest(request)) throw Error('invalid_params');
    const method = 'service.connection-set',
      binding = this.#binding(method, request);
    const prior = this.#o.store.atomic((tx) => this.#replay(tx, request.requestId, binding));
    if (prior) return serviceOwnerReceiptView(prior);
    const receipt = {
      ...this.#receipt(request.requestId, method, binding),
      expectedVersions: request.expectedVersions,
      secretReference: request.key === undefined ? null : 'psec_' + this.#o.nextId(),
    };
    let previousSecret: string | null = null;
    const record = this.#o.store.atomic((tx) => {
      const old = ownedConnection(
        tx,
        this.#o.ownerId,
        request.connectionId,
        request.expectedVersions,
      );
      assertCredentialDestination(old, request);
      previousSecret = old?.credentialReference?.startsWith('saved:')
        ? old.credentialReference.slice(6)
        : null;
      const ref = receipt.secretReference
        ? 'saved:' + receipt.secretReference
        : request.removeKey
          ? null
          : (old?.credentialReference ?? null);
      const digest =
        request.key === undefined
          ? request.removeKey
            ? undefined
            : old?.credentialBinding
          : keyDigest(this.#o.sha256, request.key)!;
      const result = ownerConnectionRecord(
        old,
        request,
        this.#o.ownerId,
        new Date(this.#o.now()).toISOString(),
        ref,
        digest,
      );
      if (request.removeKey && old?.credentialReference?.startsWith('saved:'))
        receipt.secretReference = old.credentialReference.slice(6);
      if (receipt.secretReference !== null) {
        if (!tx.putOwnerReceipt(receipt, null)) throw Error('request_conflict');
      } else {
        if (!tx.putConnection(result, request.expectedVersions)) throw Error('connection_conflict');
        this.#complete(tx, receipt, result);
      }
      return result;
    });
    if (receipt.secretReference !== null) {
      if (request.key !== undefined)
        this.#o.secrets.replace(previousSecret, receipt.secretReference, request.key);
      else this.#o.secrets.remove(receipt.secretReference);
      this.#o.store.atomic((tx) => {
        this.#assertWritable();
        ownedConnection(tx, this.#o.ownerId, request.connectionId, request.expectedVersions);
        const pending = this.#replay(tx, request.requestId, binding);
        if (pending?.state !== 'prepared' || !tx.putConnection(record, request.expectedVersions))
          throw Error('connection_conflict');
        this.#complete(tx, receipt, record, true);
      });
    }
    return this.receipt(request.requestId)!;
  }
  disconnect(request: ServiceConnectionRequest) {
    this.#assertWritable();
    if (!validServiceConnectionRequest(request)) throw Error('invalid_params');
    const method = 'service.connection-disconnect',
      binding = this.#binding(method, request);
    let changed = false;
    const done = this.#o.store.atomic((tx) => {
      const prior = this.#replay(tx, request.requestId, binding);
      if (prior) return serviceOwnerReceiptView(prior);
      const c = ownedConnection(
        tx,
        this.#o.ownerId,
        request.connectionId,
        request.expectedVersions,
      )!;
      const result = {
        ...c,
        state: 'disconnected' as const,
        configRevision: c.configRevision + 1,
        updatedAt: new Date(this.#o.now()).toISOString(),
      };
      if (!tx.putConnection(result, request.expectedVersions)) throw Error('connection_conflict');
      changed = true;
      return this.#complete(tx, this.#receipt(request.requestId, method, binding), result);
    });
    if (changed) this.#o.disconnect?.(request.connectionId);
    return done;
  }
  async refreshConnection(request: ServiceConnectionRequest, signal?: AbortSignal) {
    this.#assertWritable();
    if (!validServiceConnectionRequest(request)) throw Error('invalid_params');
    const method = 'service.connection-refresh',
      binding = this.#binding(method, request);
    const prior = this.#o.store.atomic((tx) => {
      const replay = this.#replay(tx, request.requestId, binding);
      if (replay) return replay;
      const c = ownedConnection(
        tx,
        this.#o.ownerId,
        request.connectionId,
        request.expectedVersions,
      )!;
      if (c.state !== 'active' || c.trust.metadataPermission !== 'allow')
        throw Error('metadata_permission_required');
      if (
        !tx.putOwnerReceipt(
          {
            ...this.#receipt(request.requestId, method, binding),
            expectedVersions: request.expectedVersions,
          },
          null,
        )
      )
        throw Error('request_conflict');
      return null;
    });
    if (prior) return serviceOwnerReceiptView(prior);
    await this.#o.refresh(request.connectionId, signal, (tx, result) => {
      this.#complete(
        tx,
        this.#replay(tx, request.requestId, binding)!,
        tx.connection(result.connectionId)!,
        true,
      );
    });
    return this.receipt(request.requestId)!;
  }
  setGrant(request: ServiceGrantSetRequest) {
    this.#assertWritable();
    if (!validServiceGrantSetRequest(request)) throw Error('invalid_params');
    const method = 'service.grant-set',
      binding = this.#binding(method, request);
    return this.#o.store.atomic((tx) => {
      const prior = this.#replay(tx, request.requestId, binding);
      if (prior) return serviceOwnerReceiptView(prior);
      const result =
        request.expectedRevision === null
          ? this.#owner.issue(request.intent, tx)
          : this.#owner.revise(
              { grantId: request.intent.id, revision: request.expectedRevision },
              request.intent,
              tx,
            );
      return this.#complete(tx, this.#receipt(request.requestId, method, binding), result);
    });
  }
  revokeGrant(request: ServiceGrantRevokeRequest) {
    this.#assertWritable();
    if (!validServiceGrantRevokeRequest(request)) throw Error('invalid_params');
    const method = 'service.grant-revoke',
      binding = this.#binding(method, request);
    return this.#o.store.atomic((tx) => {
      const prior = this.#replay(tx, request.requestId, binding);
      if (prior) return serviceOwnerReceiptView(prior);
      const result = this.#owner.revoke(
        { grantId: request.grantId, revision: request.expectedRevision },
        tx,
      );
      return this.#complete(tx, this.#receipt(request.requestId, method, binding), result);
    });
  }
}
