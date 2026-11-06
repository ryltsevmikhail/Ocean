import {
  LOCAL_MODEL_METHODS,
  LOCAL_SERVICE_METHODS,
  LOCAL_PROVIDER_METHODS,
} from '@runnets/contracts';
import { RuntimeServiceSettings } from './services.js';
/**
 * Host composition for runtime-owned settings surfaces.
 *
 * Keeps `host.ts` under its 300-line bound by moving provider-credential and
 * plugin-catalog composition (both private-file adapters over durable stores)
 * into one module. Providers and plugin transports arrive only from this host,
 * never over the wire.
 */

import type { ProviderHostInput } from './provider-settings.js';
import { providerHostSettings } from './provider-settings.js';
import { RuntimePlugins } from './plugins.js';
import type { Runtime } from '../runtime.js';

export interface SettingsHostsInput {
  readonly profile: string;
  readonly runtime: Pick<
    Runtime,
    | 'providerConnections'
    | 'plugins'
    | 'pluginRuntime'
    | 'conversationStore'
    | 'service'
    | 'services'
  >;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: (() => number) | undefined;
  readonly restored: boolean;
  readonly restore: boolean;
  readonly injected: ProviderHostInput['injected'];
  readonly disabled: boolean;
  readonly providerSecretStore?: ProviderHostInput['secretStore'] | undefined;
  readonly credentialDir?: string | undefined;
  readonly providerHttpClient?: ProviderHostInput['httpClient'] | undefined;
}

/** Compose the provider activation resolver and the plugin owner API. */
export function settingsHosts(input: SettingsHostsInput) {
  if (!input.runtime.providerConnections || !input.runtime.plugins || !input.runtime.services)
    throw Error('durable_runtime_required');
  const provider = providerHostSettings({
    store: input.runtime.providerConnections,
    profile: input.profile,
    env: input.env,
    now: input.now,
    restored: input.restored,
    injected: input.injected,
    disabled: input.disabled,
    mutationsAllowed: input.restore !== true,
    ...(input.providerSecretStore === undefined ? {} : { secretStore: input.providerSecretStore }),
    ...(input.credentialDir === undefined ? {} : { credentialDir: input.credentialDir }),
    ...(input.providerHttpClient === undefined ? {} : { httpClient: input.providerHttpClient }),
  });
  const pluginRuntime = input.runtime.pluginRuntime;
  if (pluginRuntime === undefined) throw Error('durable_runtime_required');
  const plugins = new RuntimePlugins({
    catalog: pluginRuntime.services.catalog,
    connections: pluginRuntime.services.connections,
    access: pluginRuntime.services.access,
    operations: pluginRuntime.operations,
  });
  if (!input.runtime.conversationStore) throw Error('durable_runtime_required');
  const models = provider.modelSettings(input.runtime.conversationStore, input.runtime.service);
  const services = new RuntimeServiceSettings(input.runtime.services.owner);
  return {
    provider,
    plugins,
    models,
    services,
    dispatch(method: string, params: Record<string, unknown>, detached: AbortSignal) {
      if (LOCAL_SERVICE_METHODS.some((m) => m === method))
        return services.dispatch(method, params, detached);
      if (LOCAL_MODEL_METHODS.some((m) => m === method))
        return models.dispatch(method, params, detached);
      if (LOCAL_PROVIDER_METHODS.some((m) => m === method))
        return provider.settings.dispatch(method, params, detached);
      if (method.startsWith('plugin.')) return plugins.dispatch(method, params);
      return null;
    },
  };
}
