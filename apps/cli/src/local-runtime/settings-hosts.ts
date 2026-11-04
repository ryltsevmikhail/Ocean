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
  readonly runtime: Pick<Runtime, 'providerConnections' | 'plugins' | 'pluginRuntime'>;
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
  if (!input.runtime.providerConnections || !input.runtime.plugins)
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
  return { provider, plugins };
}
