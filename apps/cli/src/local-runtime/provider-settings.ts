/**
 * Host composition for provider settings.
 *
 * The CLI host owns credential resolution: it builds immutable DeepSeek
 * activations from a saved key or the environment, binds the bounded model
 * probe to the private credential store, and exposes one dispatch module over
 * the authenticated local-runtime socket. Keys never reach the wire.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  ProviderConnectionService,
  requestCode,
  type ProviderConnectionStorePort,
  type ProviderCredential,
  type ProviderCredentialPort,
  type ProviderModelCapability,
  type ProviderPort,
  type ProviderProbeResult,
  type ProviderSecretStorePort,
} from '@runnets/application';
import {
  DeepSeekProvider,
  DEEPSEEK_MODEL_INFO,
  DEEPSEEK_MODELS,
  probeDeepSeekModels,
} from '@runnets/provider-deepseek';
import {
  isLocalProviderQuery,
  isLocalProviderRevisionRequest,
  isLocalProviderSetRequest,
} from '@runnets/contracts';
import { createProviderSecretStore, providerCredentialDirectory } from '@runnets/tools-node';
import { PROVIDER_ENV_KEY } from '../engine/provider.js';
import type { RuntimeReply } from './queries.js';

export interface ProviderCredentialOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Deterministic local transport seam for tests; never derived from wire input. */
  readonly baseUrl?: string;
}
/** Adapter composition; only this module knows how a key becomes a provider snapshot. */
export function createProviderCredentials(
  options: ProviderCredentialOptions,
): ProviderCredentialPort {
  const credentials: ProviderCredentialPort = {
    providerId: 'deepseek',
    models: DEEPSEEK_MODELS,
    modelCapabilities: DEEPSEEK_MODEL_INFO.map((model): ProviderModelCapability => ({
      model: model.id,
      imageInput: model.inputModalities.includes('image'),
    })),
    own: (key) => activation(key, 'saved', options),
    environment: () => {
      const key = options.env[PROVIDER_ENV_KEY];
      if (key === undefined || key.trim() === '') return null;
      return activation(key, 'external', options);
    },
  };
  return credentials;
}
function activation(
  key: string,
  source: 'saved' | 'external',
  options: ProviderCredentialOptions,
): ProviderCredential {
  const provider = new DeepSeekProvider({
    apiKey: key,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  return {
    source,
    provider,
    check: (signal) => probe(key, signal, options),
  };
}
async function probe(
  key: string,
  signal: AbortSignal,
  options: ProviderCredentialOptions,
): Promise<ProviderProbeResult> {
  const result = await probeDeepSeekModels({
    apiKey: key,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    signal,
  });
  const models = result.models.map((model) => model.id);
  return result.outcome === 'ok'
    ? { outcome: 'ok', httpStatus: result.httpStatus, models }
    : { outcome: result.outcome, httpStatus: result.httpStatus, models };
}

/** Owner API over the authenticated socket; every reply is metadata only. */
export class ProviderSettings {
  readonly #service: ProviderConnectionService;
  /** A stop must never report `complete` while an owner network check is discarded. */
  #draining = false;
  readonly #inFlight = new Set<Promise<RuntimeReply>>();
  constructor(service: ProviderConnectionService) {
    this.#service = service;
  }
  dispatch(
    method: string,
    params: Record<string, unknown>,
    detached: AbortSignal,
  ): RuntimeReply | Promise<RuntimeReply> {
    switch (method) {
      case 'provider.status':
        return isLocalProviderQuery(params)
          ? { result: this.#service.status() }
          : { error: { code: 'invalid_params' } };
      case 'provider.check':
        if (!isLocalProviderQuery(params)) return { error: { code: 'invalid_params' } };
        return this.#supervise(() => this.#service.check(detached));
      case 'provider.set':
        if (!isLocalProviderSetRequest(params)) return { error: { code: 'invalid_params' } };
        return this.#supervise(() =>
          this.#service.set({
            requestId: params.requestId,
            model: params.model,
            ...(params.key === undefined ? {} : { key: params.key }),
          }),
        );
      case 'provider.disconnect':
      case 'provider.removeSavedKey':
        if (!isLocalProviderRevisionRequest(params)) return { error: { code: 'invalid_params' } };
        return this.#supervise(() =>
          method === 'provider.disconnect'
            ? this.#service.disconnect(params)
            : this.#service.removeSavedKey(params),
        );
      default:
        return { error: { code: 'invalid_params' } };
    }
  }
  /** Track one asynchronous owner mutation until its effect is settled or refused. */
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
      return { error: { code: requestCode(error, 'outcome_unknown') } };
    }
  }
  /** Refuse new mutations and await every in-flight check/set/disconnect. */
  async drain(): Promise<'settled'> {
    this.#draining = true;
    await Promise.all(this.#inFlight);
    return 'settled';
  }
}
export interface ProviderHostInput {
  readonly store: ProviderConnectionStorePort;
  readonly profile: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: (() => number) | undefined;
  readonly restored: boolean;
  readonly injected: ProviderPort | null;
  /** Explicit host force-off: no saved or environment credential may activate. */
  readonly disabled: boolean;
  readonly mutationsAllowed: boolean;
  readonly secretStore?: ProviderSecretStorePort;
  readonly credentialDir?: string;
  readonly baseUrl?: string;
}
/** Compose the durable settings service and the activation getter for turn admission. */
export function providerHostSettings(input: ProviderHostInput): {
  readonly settings: ProviderSettings;
  readonly activation: () => ProviderPort | null;
} {
  const secrets =
    input.secretStore ??
    createProviderSecretStore(input.credentialDir ?? providerCredentialDirectory(input.profile));
  const service = new ProviderConnectionService({
    store: input.store,
    secrets,
    credentials: createProviderCredentials({
      env: input.env,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    }),
    clock: { now: () => new Date(input.now?.() ?? Date.now()) },
    nextId: () => randomUUID().replaceAll('-', ''),
    sha256: (text) => createHash('sha256').update(text).digest('hex'),
    restored: input.restored,
    injected: input.injected,
    disabled: input.disabled,
    mutationsAllowed: input.mutationsAllowed,
  });
  service.initialize();
  return { settings: new ProviderSettings(service), activation: service.activation() };
}
