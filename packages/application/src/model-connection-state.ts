import { checkLocalConnection } from './model-local-check.js';
import type { Clock } from './ports.js';
import type { ModelConnectionStorePort, ModelConnectionRecord } from './model-connection-ports.js';
import type { ModelCredentialFactory } from './model-credential-ports.js';
import type {
  ModelCheckMetadata,
  ModelConnectionCheck,
  ModelConnectionStatus,
} from './model-connection-types.js';
import type { ProviderProbeResult, ProviderSecretStorePort } from './provider-connection-ports.js';
import { checkSignal } from './provider-connection-request.js';
import {
  resolveModelConnection,
  type ModelConnectionGates,
  type ModelConnectionResolution,
} from './model-connection-resolution.js';
export interface ModelConnectionServiceOptions extends ModelConnectionGates {
  readonly store: ModelConnectionStorePort;
  readonly secrets: ProviderSecretStorePort;
  readonly factory: ModelCredentialFactory;
  readonly clock: Clock;
  readonly nextId: () => string;
  readonly sha256: (text: string) => string;
}
export class ModelConnectionReadModel {
  readonly options: ModelConnectionServiceOptions;
  constructor(options: ModelConnectionServiceOptions) {
    this.options = options;
  }
  record(id: string): ModelConnectionRecord {
    const record = this.options.store.read(id);
    if (record === null) throw Error('connection_not_found');
    return record;
  }
  resolve(record: ModelConnectionRecord): ModelConnectionResolution {
    return resolveModelConnection(record, this.options.factory, this.options.secrets, this.options);
  }
  snapshot(
    record: ModelConnectionRecord,
    resolution = this.resolve(record),
  ): ModelConnectionStatus {
    return structuredClone({
      connectionId: record.connectionId,
      providerId: record.providerId,
      kind: record.kind,
      endpoint: record.endpoint,
      auth: record.auth,
      defaultModelId: record.defaultModelId,
      source: resolution.source,
      state: resolution.state,
      models: this.options.factory.catalog(record).map(({ modelId, capabilities: c }) => ({
        modelId,
        capabilities: {
          tools: c.tools,
          streaming: c.streaming,
          inputModalities: [...c.inputModalities],
          contextTokens: c.contextTokens,
          maxOutputTokens: c.maxOutputTokens,
          usage: c.usage,
        },
      })),
      revision: record.revision,
      savedKey: record.secretRef !== null,
      writable:
        this.options.mutationsAllowed !== false &&
        (this.options.injected === null || this.options.injected === undefined) &&
        this.options.disabled !== true,
      code: resolution.code,
      lastCheck: record.lastCheck,
    });
  }
  status(id: string): ModelConnectionStatus {
    return this.snapshot(this.record(id));
  }
  async check(id: string, signal?: AbortSignal): Promise<ModelConnectionCheck> {
    const record = this.record(id);
    if (this.options.factory.localBootstrap?.acceptsDesired(record) === true)
      return checkLocalConnection(this, record, signal);
    const resolution = this.resolve(record);
    const checkedAt = this.options.clock.now().toISOString();
    const start = Date.now();
    let result: ProviderProbeResult = { outcome: 'unavailable', httpStatus: null, models: [] };
    if (resolution.credential !== null) {
      try {
        result = await resolution.credential.check(checkSignal(signal));
      } catch {
        /* Bounded sanitized refusal. */
      }
    }
    const metadata: ModelCheckMetadata = {
      connectionId: id,
      outcome: result.outcome,
      httpStatus: result.httpStatus,
      durationMs: resolution.credential === null ? 0 : Math.max(0, Date.now() - start),
      models: result.models,
      modelSupported: result.models.includes(
        record.defaultModelId ?? this.options.factory.catalog(record)[0]?.modelId ?? '',
      ),
      source: resolution.source,
      revision: record.revision,
      checkedAt,
    };
    let persisted = false;
    if (resolution.credential !== null && record.intent !== 'unconfigured') {
      try {
        const current = this.record(id);
        if (current.revision === record.revision) {
          this.options.store.put({ ...current, lastCheck: metadata }, record.revision);
          persisted = true;
        }
      } catch {
        /* A stale check cannot overwrite new configuration. */
      }
    }
    return { status: this.status(id), check: { ...metadata, persisted } };
  }
}
