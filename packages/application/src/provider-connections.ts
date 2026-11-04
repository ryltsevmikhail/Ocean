/** Legacy request/receipt translator. The canonical engine owns every mutation and publication. */
import type { Clock } from './ports.js';
import type {
  ProviderConnectionStatus,
  ProviderConnectionStorePort,
  ProviderCredentialPort,
  ProviderRevisionInput,
  ProviderSecretStorePort,
  ProviderSetInput,
} from './provider-connection-ports.js';
import type { ProviderPort } from './provider.js';
import { ModelConnectionReadModel } from './model-connection-state.js';
import { ModelConnectionMutations } from './model-connection-mutations.js';
import {
  unconfiguredModelConnection,
  type ModelConnectionRecord,
} from './model-connection-ports.js';
import { providerModelCredentials } from './provider-model-credentials.js';
import { legacyCheck, legacyStatus } from './provider-connection-state.js';
import {
  bindingFor,
  keyDigest,
  validKey,
  validModel,
  validRequestId,
  validRevision,
  type Sha256,
} from './provider-connection-request.js';
export interface ProviderConnectionServiceOptions {
  readonly store: ProviderConnectionStorePort;
  readonly secrets: ProviderSecretStorePort;
  readonly credentials: ProviderCredentialPort;
  readonly clock: Clock;
  readonly nextId: () => string;
  readonly sha256: Sha256;
  readonly restored?: boolean;
  readonly injected?: ProviderPort | null;
  readonly disabled?: boolean;
  readonly mutationsAllowed?: boolean;
}
export class ProviderConnectionService {
  readonly #state: ModelConnectionReadModel;
  readonly #mutations: ModelConnectionMutations<ProviderConnectionStatus>;
  readonly #id: string;
  readonly options: ProviderConnectionServiceOptions;
  constructor(options: ProviderConnectionServiceOptions) {
    this.options = options;
    this.#id = `legacy:${options.credentials.providerId}`;
    // A transient placeholder carries no authority. It is persisted only by an explicit mutation.
    const canonical = options.store.connections;
    const store = {
      list: () => canonical.list(),
      read: (id: string) =>
        canonical.read(id) ??
        (id === this.#id ? unconfiguredModelConnection(options.credentials.providerId) : null),
      put: (record: ModelConnectionRecord, expected: number | null) =>
        canonical.put(record, canonical.read(record.connectionId) === null ? null : expected),
      activate: canonical.activate.bind(canonical),
      receipt: canonical.receipt.bind(canonical),
    };
    this.#state = new ModelConnectionReadModel({
      ...options,
      store,
      factory: providerModelCredentials(options.credentials),
    });
    this.#mutations = new ModelConnectionMutations(this.#state, {
      legacy: true,
      replay: (id, binding) => {
        const receipt = canonical.legacyReceipt(id);
        if (receipt === null) return null;
        if (receipt.binding !== binding) throw Error('request_conflict');
        return receipt.result;
      },
      snapshot: (record, resolution) =>
        legacyStatus(this.#state, record, options.credentials, resolution),
      activate: (record, expected, requestId, binding, result) =>
        canonical.activateLegacy(
          record,
          canonical.read(record.connectionId) === null ? null : expected,
          { requestId, value: { binding, result } },
        ),
    });
  }
  #record() {
    const record = this.#state.record(this.#id);
    if (!record.legacyEnvironment) throw Error('provider_unverified');
    return record;
  }
  initialize(): void {
    this.#record();
  }
  status(): ProviderConnectionStatus {
    return legacyStatus(this.#state, this.#record(), this.options.credentials);
  }
  current(): ProviderPort | null {
    if (this.options.disabled === true) return null;
    if (this.options.injected !== null && this.options.injected !== undefined)
      return this.options.injected;
    try {
      return this.#state.resolve(this.#record()).credential?.provider ?? null;
    } catch {
      return null;
    }
  }
  activation(): () => ProviderPort | null {
    return () => this.current();
  }
  async check(signal?: AbortSignal) {
    this.#record();
    const result = await this.#state.check(this.#id, signal);
    const { persisted, ...metadata } = result.check;
    return { status: this.status(), check: { ...legacyCheck(metadata)!, persisted } };
  }
  set(input: ProviderSetInput): ProviderConnectionStatus {
    this.#mutations.assertWritable();
    const requestId = validRequestId(input.requestId);
    const key = input.key === undefined ? undefined : validKey(input.key);
    const binding = bindingFor(this.options.sha256, [
      'ProviderSet',
      this.options.credentials.providerId,
      typeof input.model === 'string' ? input.model : null,
      keyDigest(this.options.sha256, key),
    ]);
    // Exact legacy replay precedes today's catalog, metadata and credentials.
    const receipt = this.options.store.connections.legacyReceipt(requestId);
    if (receipt !== null) {
      if (receipt.binding !== binding) throw Error('request_conflict');
      return receipt.result;
    }
    const model = validModel(input.model, this.options.credentials.models);
    const record = this.#record();
    return this.#mutations.set(
      {
        connectionId: this.#id,
        requestId,
        binding,
        expected: undefined,
        pendingRequest: {
          version: 1,
          operation: {
            method: 'provider.set',
            input: { requestId, model },
            keyWasSupplied: key !== undefined,
          },
        },
      },
      {
        connectionId: this.#id,
        providerId: record.providerId,
        kind: record.kind,
        endpoint: record.endpoint,
        auth: record.auth,
        defaultModelId: model,
        localQualification: null,
      },
      key,
    );
  }
  disconnect(input: ProviderRevisionInput) {
    return this.#revise(input, 'disconnect');
  }
  removeSavedKey(input: ProviderRevisionInput) {
    return this.#revise(input, 'remove');
  }
  #revise(input: ProviderRevisionInput, action: 'disconnect' | 'remove') {
    this.#mutations.assertWritable();
    const requestId = validRequestId(input.requestId);
    const revision = validRevision(input.expectedRevision);
    const binding = bindingFor(this.options.sha256, [
      action === 'disconnect' ? 'ProviderDisconnect' : 'ProviderRemoveSavedKey',
      this.options.credentials.providerId,
      revision,
    ]);
    return this.#mutations.revise(
      {
        connectionId: this.#id,
        requestId,
        binding,
        expected: revision,
        ...(action === 'remove'
          ? {
              pendingRequest: {
                version: 1 as const,
                operation: {
                  method: 'provider.removeSavedKey' as const,
                  input: { requestId, expectedRevision: revision },
                },
              },
            }
          : {}),
      },
      action,
    );
  }
}
