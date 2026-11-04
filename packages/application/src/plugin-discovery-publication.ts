/** Validate a complete observation, commit durable authority, then activate its session. */
import { canonicalJson } from '@runnets/domain';
import type { PluginManifest } from '@runnets/domain';
import {
  PluginRefusedError,
  type PluginConnectionRecord,
  type PluginConnectionStorePort,
  type PluginDiscoveryPublicationResult,
} from './plugin-ports.js';
import type {
  ServicePluginCatalog,
  ServicePluginTransportPort,
} from './service-plugin-transport.js';
import { requireDeclaredTools, validDiscoveredTools } from './plugin-catalog-tools.js';
import { pluginConnectionTarget } from './plugin-session-authority.js';

export function publishPluginDiscovery(input: {
  readonly store: PluginConnectionStorePort;
  readonly transport: ServicePluginTransportPort;
  readonly connection: PluginConnectionRecord;
  readonly catalog: ServicePluginCatalog;
  readonly manifest: PluginManifest;
  readonly version: string;
  readonly adapterVersion: string;
  readonly sha256: (text: string) => string;
  readonly now: string;
}): PluginDiscoveryPublicationResult {
  const { connection, catalog, store, transport } = input;
  const refuse = (code: string): never => {
    throw new PluginRefusedError(code, 'plugin discovery refused: ' + code);
  };
  if (catalog.completeness !== 'complete') refuse('catalog_incomplete');
  const validated = validDiscoveredTools(catalog.tools, input.sha256, canonicalJson);
  if (catalog.schemaDigest !== validated.digest) refuse('schema_digest_mismatch');
  if (canonicalJson(catalog.target) !== canonicalJson(pluginConnectionTarget(connection)))
    refuse('target_mismatch');
  const account = catalog.account;
  if (
    account.identity !== null &&
    (typeof account.identity !== 'string' || account.identity.length > 256)
  )
    refuse('invalid_identity');
  requireDeclaredTools(input.manifest, validated.tools);
  if (transport.sessions?.current(catalog) === false) {
    store.change(connection.id, connection.generation, {}, input.now);
    refuse('credential_changed');
  }
  const publication = store.publishDiscovery({
    connectionId: connection.id,
    expectedGeneration: connection.generation,
    pluginVersion: input.version,
    adapterVersion: input.adapterVersion,
    schemaDigest: validated.digest,
    tools: validated.tools,
    identity: { identity: account.identity, verified: account.verified === true },
    discoveredAt: input.now,
  });
  if (
    transport.sessions?.publish(catalog, pluginConnectionTarget(publication.connection)) === false
  ) {
    store.change(connection.id, publication.connection.generation, {}, input.now);
    refuse('discovery_required');
  }
  return publication;
}
