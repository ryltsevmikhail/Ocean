/** Runtime session readiness cannot itself grant any durable permission. */
import type { PluginConnectionRecord, PluginConnectionStorePort } from './plugin-ports.js';
import type {
  ServicePluginTarget,
  ServicePluginTransportPort,
} from './service-plugin-transport.js';

export function pluginConnectionTarget(connection: PluginConnectionRecord): ServicePluginTarget {
  return {
    integrationId: connection.pluginId,
    connectionId: connection.id,
    owner: 'user',
    authority: {
      generation: connection.generation,
      endpoint: connection.endpoint,
      pluginVersion: connection.pluginVersion,
      adapterVersion: connection.adapterVersion,
      credentialReference: connection.credentialReference,
    },
  };
}

export function pluginSessionReady(
  transport: Pick<ServicePluginTransportPort, 'sessions'>,
  connection: PluginConnectionRecord,
): boolean {
  return transport.sessions?.ready(pluginConnectionTarget(connection)) ?? true;
}

/** Called by the exclusive runtime owner. Unknown continuity revokes before rediscovery. */
export function reconcilePluginSession(
  store: PluginConnectionStorePort,
  transport: ServicePluginTransportPort,
  connection: PluginConnectionRecord,
  at: string,
): PluginConnectionRecord {
  if (
    !transport.qualification().qualified ||
    connection.state !== 'active' ||
    connection.schemaDigest === null ||
    pluginSessionReady(transport, connection)
  )
    return connection;
  return store.change(connection.id, connection.generation, {}, at);
}
