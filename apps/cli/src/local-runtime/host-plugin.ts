/**
 * Host composition for the service-plugin transport.
 *
 * Split from `host.ts` so the composed start path stays within the source
 * bound. The transport arrives only from this host, never over the wire, and
 * the plugin connection store is bound after the runtime opens it.
 */

import { DisabledPluginTransport } from '../plugin-runtime.js';
import type { PluginConnectionStorePort, ServicePluginTransportPort } from '@runnets/application';
import type { LocalRuntimeHostOptions } from './host-options.js';

export interface HostPluginSettings {
  readonly transport: ServicePluginTransportPort;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Bind the runtime-owned connection store after the profile is open. */
  connections(store: PluginConnectionStorePort | undefined): void;
}

export async function hostPluginSettings(
  options: Pick<
    LocalRuntimeHostOptions,
    'pluginTransport' | 'pluginEnv' | 'pluginEndpointOverride'
  >,
): Promise<HostPluginSettings> {
  await Promise.resolve();
  const env = options.pluginEnv ?? process.env;

  const transport = options.pluginTransport ?? new DisabledPluginTransport();
  return {
    transport,
    env,
    connections() {},
  };
}
