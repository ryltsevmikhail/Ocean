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
import { runtimePluginsHost, type RuntimePluginHostOptions } from './plugins.js';
import type { Runtime } from '../runtime.js';

export interface SettingsHostsInput {
  readonly profile: string;
  readonly runtime: Pick<Runtime, 'providerConnections' | 'plugins'>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: (() => number) | undefined;
  readonly restored: boolean;
  readonly restore: boolean;
  readonly injected: ProviderHostInput['injected'];
  readonly disabled: boolean;
  readonly providerSecretStore?: ProviderHostInput['secretStore'] | undefined;
  readonly credentialDir?: string | undefined;
  readonly providerBaseUrl?: string | undefined;
  readonly pluginTransport?: RuntimePluginHostOptions['transport'] | undefined;
}

/** Compose the provider activation getter and the plugin owner API. */
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
    ...(input.providerBaseUrl === undefined ? {} : { baseUrl: input.providerBaseUrl }),
  });
  const plugins = runtimePluginsHost({
    profile: input.profile,
    stores: input.runtime.plugins,
    restored: input.restored,
    mutationsAllowed: input.restore !== true && !input.restored,
    ...(input.pluginTransport === undefined ? {} : { transport: input.pluginTransport }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { provider, plugins };
}
