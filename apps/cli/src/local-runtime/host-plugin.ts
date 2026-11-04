/**
 * Host composition for the service-plugin transport.
 *
 * Split from `host.ts` so the composed start path stays within the source
 * bound. The transport arrives only from this host, never over the wire, and
 * the plugin connection store is bound after the runtime opens it.
 */

import { hostPluginTransport } from '../plugin-transport.js';
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
  const env = options.pluginEnv ?? process.env;
  let connections: PluginConnectionStorePort | undefined;
  const transport = await hostPluginTransport({
    transport: options.pluginTransport,
    env,
    connections: () => connections,
    ...(options.pluginEndpointOverride === undefined
      ? {}
      : { endpointOverride: options.pluginEndpointOverride }),
  });
  return {
    transport,
    env,
    connections(store) {
      connections = store;
    },
  };
}
