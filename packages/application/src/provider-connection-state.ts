/**
 * Provider connection read side.
 *
 * Owns the authoritative refresh of metadata plus private credential reads,
 * the derived connection status, and the explicit bounded check. Mutations live
 * in the service; this module never changes configuration by itself.
 */

import type { Clock } from './ports.js';
import type {
  ProviderCheckMetadata,
  ProviderConnectionCheck,
  ProviderConnectionRecord,
  ProviderConnectionStatus,
  ProviderConnectionStorePort,
  ProviderCredential,
  ProviderCredentialPort,
  ProviderProbeResult,
  ProviderSecretRead,
  ProviderSecretStorePort,
} from './provider-connection-ports.js';
import {
  resolveProviderConnection,
  type ProviderConnectionResolution,
} from './provider-connection-resolution.js';
import { checkSignal } from './provider-connection-request.js';
import type { ProviderPort } from './provider.js';

export interface ProviderConnectionReadModelOptions {
  readonly store: ProviderConnectionStorePort;
  readonly secrets: ProviderSecretStorePort;
  readonly credentials: ProviderCredentialPort;
  readonly clock: Clock;
  readonly injected?: ProviderPort | null;
  /** Explicit host force-off: no provider activates, not even an environment credential. */
  readonly disabled?: boolean;
  readonly restored?: boolean;
  readonly mutationsAllowed?: boolean;
}
export class ProviderConnectionReadModel {
  readonly #store: ProviderConnectionStorePort;
  readonly #secrets: ProviderSecretStorePort;
  readonly #credentials: ProviderCredentialPort;
  readonly #clock: Clock;
  readonly #injected: ProviderPort | null;
  readonly #disabled: boolean;
  readonly #mutationsAllowed: boolean;
  #restored: boolean;
  #record: ProviderConnectionRecord | null = null;
  #resolution: ProviderConnectionResolution | null = null;
  constructor(options: ProviderConnectionReadModelOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#credentials = options.credentials;
    this.#clock = options.clock;
    this.#injected = options.injected ?? null;
    this.#disabled = options.disabled === true;
    this.#mutationsAllowed = options.mutationsAllowed ?? true;
    this.#restored = options.restored === true;
  }
  initialize(): void {
    this.refresh();
  }
  record(): ProviderConnectionRecord | null {
    return this.#record;
  }
  restored(): boolean {
    return this.#restored;
  }
  clearRestored(): void {
    this.#restored = false;
  }
  /** Immutable activation for a newly admitted turn; null means provider_unavailable. */
  current(): ProviderPort | null {
    if (this.#disabled) return null;
    if (this.#injected !== null) return this.#injected;
    return this.#resolution?.credential?.provider ?? null;
  }
  /** Activation getter handed to the turns owner so later turns see a later configuration. */
  activation(): () => ProviderPort | null {
    return () => this.current();
  }
  status(): ProviderConnectionStatus {
    this.refresh();
    return this.#status();
  }
  statusFor(
    resolution: ProviderConnectionResolution,
    record: ProviderConnectionRecord | null,
  ): ProviderConnectionStatus {
    return {
      provider: this.#credentials.providerId,
      source: resolution.source,
      state: resolution.state,
      model: resolution.model,
      models: this.#credentials.models,
      modelCapabilities: this.#credentials.modelCapabilities,
      revision: resolution.revision,
      savedKey: resolution.savedKey,
      writable: this.#mutationsAllowed && this.#injected === null && !this.#disabled,
      code: resolution.code,
      lastCheck: record?.lastCheck ?? null,
    };
  }
  resolutionFor(
    record: ProviderConnectionRecord,
    secret: ProviderSecretRead | null,
    restored = this.#restored,
  ): ProviderConnectionResolution {
    return resolveProviderConnection({
      record,
      secret,
      environment: this.#credentials.environment(),
      credentials: this.#credentials,
      restored,
    });
  }
  readSecret(ref: string): ProviderSecretRead | null {
    try {
      return this.#secrets.read(ref);
    } catch {
      return { status: 'unverified', reason: 'provider_secret_insecure' };
    }
  }
  /** Persist intent and receipt, then refresh from the authoritative store. */
  activate(
    record: ProviderConnectionRecord,
    expected: number | null,
    requestId: string,
    binding: string,
    resolution: ProviderConnectionResolution,
    configured: boolean,
  ): ProviderConnectionStatus {
    this.#store.activate(record, expected, {
      requestId,
      value: { binding, result: this.statusFor(resolution, record) },
    });
    if (configured) this.#restored = false;
    this.refresh();
    return this.#status();
  }
  /** Explicit owner-triggered bounded check; no inference and never on startup. */
  async check(signal?: AbortSignal): Promise<ProviderConnectionCheck> {
    this.refresh();
    const resolution = this.#resolution!;
    const checkedAt = this.#clock.now().toISOString();
    if (this.#injected !== null || resolution.credential === null) {
      return {
        status: this.#status(),
        check: {
          outcome: 'unavailable',
          httpStatus: null,
          durationMs: 0,
          models: [],
          modelSupported: false,
          source: resolution.source,
          revision: resolution.revision,
          checkedAt,
          persisted: false,
        },
      };
    }
    const started = Date.now();
    const result = await this.#probe(resolution.credential, checkSignal(signal));
    const metadata: ProviderCheckMetadata = {
      outcome: result.outcome,
      httpStatus: result.httpStatus,
      durationMs: Math.max(0, Date.now() - started),
      models: result.models,
      modelSupported: resolution.model !== null && result.models.includes(resolution.model),
      source: resolution.source,
      revision: resolution.revision,
      checkedAt,
    };
    const persisted = this.#persistCheck(metadata);
    this.refresh();
    return { status: this.#status(), check: { ...metadata, persisted } };
  }
  refresh(): void {
    const record = this.#store.read(this.#credentials.providerId);
    const secretRef = record?.secretRef;
    const secret =
      secretRef === null || secretRef === undefined ? null : this.readSecret(secretRef);
    this.#record = record;
    this.#resolution = this.#disabled
      ? this.#disabledResolution(record)
      : this.#injected === null
        ? resolveProviderConnection({
            record,
            secret,
            environment: this.#credentials.environment(),
            credentials: this.#credentials,
            restored: this.#restored,
          })
        : this.#injectedResolution(record);
  }
  /** An explicitly forced-off host has no provider at all: environment values stay untapped. */
  #disabledResolution(record: ProviderConnectionRecord | null): ProviderConnectionResolution {
    return {
      source: 'none',
      state: 'absent',
      code: null,
      model: record?.model ?? this.#credentials.models[0] ?? null,
      credential: null,
      savedKey: record?.secretRef !== null && record?.secretRef !== undefined,
      revision: record?.revision ?? 0,
    };
  }
  #injectedResolution(record: ProviderConnectionRecord | null): ProviderConnectionResolution {
    const models = this.#credentials.models;
    const model =
      record?.model !== null && record?.model !== undefined && models.includes(record.model)
        ? record.model
        : (models[0] ?? null);
    return {
      source: 'injected',
      state: 'connected',
      code: null,
      model,
      credential: null,
      savedKey: record?.secretRef !== null && record?.secretRef !== undefined,
      revision: record?.revision ?? 0,
    };
  }
  #persistCheck(metadata: ProviderCheckMetadata): boolean {
    try {
      const record = this.#store.read(this.#credentials.providerId);
      if (record === null || record.revision !== metadata.revision) return false;
      this.#store.put({ ...record, lastCheck: metadata }, record.revision);
      return true;
    } catch {
      // A stale or unreadable store keeps the result transient; a newer config is never overwritten.
      return false;
    }
  }
  async #probe(credential: ProviderCredential, signal: AbortSignal): Promise<ProviderProbeResult> {
    try {
      return await credential.check(signal);
    } catch {
      return { outcome: 'unavailable', httpStatus: null, models: [] };
    }
  }
  #status(): ProviderConnectionStatus {
    return this.statusFor(this.#resolution!, this.#record);
  }
}
