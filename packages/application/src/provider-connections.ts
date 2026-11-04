/**
 * Provider connection mutation service.
 *
 * Metadata and one-way request fingerprints live in durable state, credential
 * bytes live only in the private filesystem store, and host adapters turn them
 * into provider snapshots. Intent is persisted before any publication, an
 * unreadable or pending state fails closed instead of silently falling back to
 * the environment, and an explicit disconnect outranks a retained saved secret
 * and the environment alike.
 */

import type { Clock } from './ports.js';
import type {
  ProviderConnectionRecord,
  ProviderConnectionStatus,
  ProviderConnectionStorePort,
  ProviderRevisionInput,
  ProviderSecretStorePort,
  ProviderSetInput,
} from './provider-connection-ports.js';
import { ProviderConnectionReadModel } from './provider-connection-state.js';
import {
  bindingFor,
  keyDigest,
  requestCode,
  validKey,
  validModel,
  validRequestId,
  validRevision,
  type Sha256,
} from './provider-connection-request.js';
import type { ProviderCredentialPort } from './provider-connection-ports.js';
import type { ProviderPort } from './provider.js';

export interface ProviderConnectionServiceOptions {
  readonly store: ProviderConnectionStorePort;
  readonly secrets: ProviderSecretStorePort;
  readonly credentials: ProviderCredentialPort;
  readonly clock: Clock;
  readonly nextId: () => string;
  readonly sha256: Sha256;
  /** Restored profiles stay inert until the owner explicitly configures them again. */
  readonly restored?: boolean;
  /** Explicit host test seam; the injected provider is the session activation, read-only. */
  readonly injected?: ProviderPort | null;
  /** False on a restore-mode maintenance host: reads stay available, mutations refuse. */
  readonly mutationsAllowed?: boolean;
}
type SetBinding = { readonly requestId: string; readonly binding: string; readonly model: string };
/** One owner-visible connection; credentials never leave this object. */
export class ProviderConnectionService {
  readonly #store: ProviderConnectionStorePort;
  readonly #secrets: ProviderSecretStorePort;
  readonly #credentials: ProviderCredentialPort;
  readonly #clock: Clock;
  readonly #nextId: () => string;
  readonly #sha256: Sha256;
  readonly #injected: boolean;
  readonly #mutationsAllowed: boolean;
  readonly #state: ProviderConnectionReadModel;
  constructor(options: ProviderConnectionServiceOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#credentials = options.credentials;
    this.#clock = options.clock;
    this.#nextId = options.nextId;
    this.#sha256 = options.sha256;
    this.#injected = options.injected !== null && options.injected !== undefined;
    this.#mutationsAllowed = options.mutationsAllowed ?? true;
    this.#state = new ProviderConnectionReadModel(options);
  }
  initialize(): void {
    this.#state.initialize();
  }
  status(): ProviderConnectionStatus {
    return this.#state.status();
  }
  current(): ProviderPort | null {
    return this.#state.current();
  }
  activation(): () => ProviderPort | null {
    return this.#state.activation();
  }
  check(signal?: AbortSignal) {
    return this.#state.check(signal);
  }
  set(input: ProviderSetInput): ProviderConnectionStatus {
    this.#assertWritable();
    const requestId = validRequestId(input.requestId);
    const key = input.key === undefined ? undefined : validKey(input.key);
    const binding = bindingFor(this.#sha256, [
      'ProviderSet',
      this.#credentials.providerId,
      typeof input.model === 'string' ? input.model : null,
      keyDigest(this.#sha256, key),
    ]);
    const replay = this.#replay(requestId, binding);
    if (replay !== null) return replay;
    const model = validModel(input.model, this.#credentials.models);
    this.#state.refresh();
    const record = this.#state.record();
    if (record !== null && record.requestId === requestId) {
      if (record.binding !== binding) throw Error('request_conflict');
      // The same request reached activation only partially: finish it, never duplicate it.
      if (record.intent === 'pending') return this.#finishPending(record, key);
      return this.#state.status();
    }
    return key === undefined
      ? this.#selectModel(record, model, { requestId, binding, model })
      : this.#publish(record, key, { requestId, binding, model });
  }
  /** Persist an explicit block; the retained secret is never reactivated by it. */
  disconnect(input: ProviderRevisionInput): ProviderConnectionStatus {
    this.#assertWritable();
    const requestId = validRequestId(input.requestId);
    const expected = validRevision(input.expectedRevision);
    const binding = bindingFor(this.#sha256, [
      'ProviderDisconnect',
      this.#credentials.providerId,
      expected,
    ]);
    const replay = this.#replay(requestId, binding);
    if (replay !== null) return replay;
    this.#state.refresh();
    const record = this.#state.record();
    if (record !== null && record.requestId === requestId) return this.#state.status();
    this.#assertRevision(record, expected);
    const blocked: ProviderConnectionRecord = {
      provider: this.#credentials.providerId,
      model: record?.model ?? null,
      secretRef: record?.secretRef ?? null,
      intent: 'disconnected',
      revision: (record?.revision ?? 0) + 1,
      requestId,
      binding,
      lastCheck: record?.lastCheck ?? null,
      updatedAt: this.#clock.now().toISOString(),
    };
    const resolution = this.#state.resolutionFor(blocked, null);
    this.#state.activate(blocked, record?.revision ?? null, requestId, binding, resolution, false);
    return this.#state.status();
  }
  /** Delete only the Ocean-managed value; an external environment value stays untouched. */
  removeSavedKey(input: ProviderRevisionInput): ProviderConnectionStatus {
    this.#assertWritable();
    const requestId = validRequestId(input.requestId);
    const expected = validRevision(input.expectedRevision);
    const binding = bindingFor(this.#sha256, [
      'ProviderRemoveSavedKey',
      this.#credentials.providerId,
      expected,
    ]);
    const replay = this.#replay(requestId, binding);
    if (replay !== null) return replay;
    this.#state.refresh();
    const record = this.#state.record();
    if (record !== null && record.requestId === requestId) {
      if (record.intent === 'pending') return this.#finishPending(record, undefined);
      return this.#state.status();
    }
    this.#assertRevision(record, expected);
    const removal: ProviderConnectionRecord = {
      provider: this.#credentials.providerId,
      model: record?.model ?? null,
      secretRef: null,
      intent: 'pending',
      revision: (record?.revision ?? 0) + 1,
      requestId,
      binding,
      lastCheck: record?.lastCheck ?? null,
      updatedAt: this.#clock.now().toISOString(),
    };
    this.#store.put(removal, record?.revision ?? null);
    const previous = record?.secretRef;
    if (previous !== null && previous !== undefined)
      this.#writeEffect(() => this.#secrets.remove(previous));
    return this.#finishPending(removal, undefined);
  }
  #assertWritable(): void {
    if (!this.#mutationsAllowed) throw Error('restore_restricted');
    if (this.#injected) throw Error('provider_injected');
  }
  #assertRevision(record: ProviderConnectionRecord | null, expected: number): void {
    if ((record?.revision ?? 0) !== expected) throw Error('revision_conflict');
  }
  #replay(requestId: string, binding: string): ProviderConnectionStatus | null {
    const receipt = this.#store.receipt(requestId);
    if (receipt === null) return null;
    if (receipt.binding !== binding) throw Error('request_conflict');
    return receipt.result;
  }
  #writeEffect(effect: () => void): void {
    try {
      effect();
    } catch (error) {
      // The persisted intent stays pending, so status fails closed rather than guessing.
      throw Error(requestCode(error, 'provider_write_failed'));
    }
  }
  #publish(
    record: ProviderConnectionRecord | null,
    key: string,
    set: SetBinding,
  ): ProviderConnectionStatus {
    const revision = (record?.revision ?? 0) + 1;
    const secretRef = 'psec_' + this.#nextId();
    const intent: ProviderConnectionRecord = {
      provider: this.#credentials.providerId,
      model: set.model,
      secretRef,
      intent: 'pending',
      revision,
      requestId: set.requestId,
      binding: set.binding,
      lastCheck: record?.lastCheck ?? null,
      updatedAt: this.#clock.now().toISOString(),
    };
    this.#store.put(intent, record?.revision ?? null);
    this.#writeEffect(() => this.#secrets.write(secretRef, key));
    const published = this.#state.readSecret(secretRef);
    if (published === null || published.status !== 'ok' || published.key !== key)
      throw Error('provider_unverified');
    const status = this.#finish(intent, key);
    const previous = record?.secretRef;
    if (previous !== null && previous !== undefined && previous !== secretRef) {
      try {
        this.#secrets.remove(previous);
      } catch {
        // An orphaned private value is inert; it is never activated again.
      }
    }
    return status;
  }
  #selectModel(
    record: ProviderConnectionRecord | null,
    model: string,
    set: SetBinding,
  ): ProviderConnectionStatus {
    const secretRef = record?.secretRef ?? null;
    const secret = secretRef === null ? null : this.#state.readSecret(secretRef);
    const readable = secret !== null && secret.status === 'ok';
    const next: ProviderConnectionRecord = {
      provider: this.#credentials.providerId,
      model,
      secretRef: readable ? secretRef : null,
      intent: 'active',
      revision: (record?.revision ?? 0) + 1,
      requestId: set.requestId,
      binding: set.binding,
      lastCheck: record?.lastCheck ?? null,
      updatedAt: this.#clock.now().toISOString(),
    };
    const resolution = this.#state.resolutionFor(next, readable ? secret : null, false);
    this.#state.activate(
      next,
      record?.revision ?? null,
      set.requestId,
      set.binding,
      resolution,
      true,
    );
    return this.#state.status();
  }
  /** Resume a persisted intent: activation completes only for the same owner request. */
  #finishPending(
    record: ProviderConnectionRecord,
    key: string | undefined,
  ): ProviderConnectionStatus {
    if (record.secretRef !== null) {
      if (key === undefined) throw Error('provider_unverified');
      this.#writeEffect(() => this.#secrets.write(record.secretRef!, key));
      const published = this.#state.readSecret(record.secretRef);
      if (published === null || published.status !== 'ok' || published.key !== key)
        throw Error('provider_unverified');
    }
    return this.#finish(record, key);
  }
  #finish(intent: ProviderConnectionRecord, key: string | undefined): ProviderConnectionStatus {
    const activated: ProviderConnectionRecord = { ...intent, intent: 'active' };
    const secret = intent.secretRef === null ? null : this.#state.readSecret(intent.secretRef);
    const resolution = this.#state.resolutionFor(
      activated,
      secret,
      key === undefined ? undefined : false,
    );
    return this.#state.activate(
      activated,
      intent.revision,
      intent.requestId ?? '',
      intent.binding ?? '',
      resolution,
      key !== undefined || secret !== null,
    );
  }
}
