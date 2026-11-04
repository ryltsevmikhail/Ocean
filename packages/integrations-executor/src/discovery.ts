/**
 * Bounded, freshly observed discovery.
 *
 * Fail-closed catalog observation: every call performs one bounded upstream
 * catalog re-discovery (`connections.refresh`) before reading the catalog, so a
 * stale or previously failed persisted snapshot can never be returned as a
 * successful catalog. Any refusal or failure raises
 * `ServicePluginDiscoveryRefusedError`, and an incomplete listing (the SDK's
 * `tool_sync_failed` health marker / "Tool sync failing" detail, or a failed
 * refresh) is `catalog_incomplete`, never an authoritative empty catalog.
 *
 * The caps are enforced on the observed result (tool count, canonical payload
 * bytes), while the guarded HTTP layer separately caps each response stream, so
 * a plugin cannot return an unbounded catalog. The deadline is a wall-clock
 * bound: it is re-checked after the listing (including schema backfill).
 */
import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  SERVICE_PLUGIN_DISCOVERY_DEADLINE_MS,
  SERVICE_PLUGIN_MAX_DISCOVERY_BYTES,
  SERVICE_PLUGIN_MAX_TOOLS,
  ServicePluginDiscoveryRefusedError,
} from '@runnets/application';
import type {
  ServicePluginAccountIdentity,
  ServicePluginCatalog,
  ServicePluginDiscoveryFailureCode,
  ServicePluginDiscoveryOptions,
  ServicePluginJson,
  ServicePluginTarget,
  ServicePluginTool,
} from '@runnets/application';

import type { ExecutorHost, HostConnection, HostTool, HostToolFilter } from './host-types.js';
import { HostOperationError } from './host-types.js';
import { canonicalJson, sha256Hex, toServicePluginJson, utf8Bytes } from './json.js';

/** Clamp a requested discovery deadline to the per-call ceiling. */
export function discoveryDeadlineMs(requested: number | undefined): number {
  if (requested === undefined) return SERVICE_PLUGIN_DISCOVERY_DEADLINE_MS;
  if (!Number.isFinite(requested)) return 0;
  return Math.min(Math.max(Math.floor(requested), 0), SERVICE_PLUGIN_CALL_DEADLINE_MS);
}

function refused(code: ServicePluginDiscoveryFailureCode, message: string): never {
  throw new ServicePluginDiscoveryRefusedError(code, message);
}

function readIdentity(connection: HostConnection): ServicePluginAccountIdentity {
  const health = connection.lastHealth;
  // `verified` only mirrors a persisted upstream health observation; a
  // user-supplied label stays honestly unverified.
  if (health !== null && health.status === 'healthy' && health.identity !== null) {
    return { identity: health.identity, verified: true };
  }
  return { identity: connection.identityLabel, verified: false };
}

/**
 * An SDK `tool_sync_failed` marker means the listing was not completed.
 * A connection without a health record has nothing suggesting incompleteness.
 */
function isIncomplete(connection: HostConnection): boolean {
  const health = connection.lastHealth;
  if (health === null) return false;
  if (health.reason === 'tool_sync_failed') return true;
  return health.detail !== null && health.detail.startsWith('Tool sync failing');
}

function toTool(tool: HostTool): ServicePluginTool | null {
  const schema = toServicePluginJson(tool.inputSchema ?? null);
  if (schema.lossy) return null;
  return { name: tool.name, description: tool.description, inputSchema: schema.value };
}

function toDiscoveryFailure(error: HostOperationError): ServicePluginDiscoveryFailureCode {
  switch (error.failure) {
    case 'timeout':
      return 'deadline_exceeded';
    case 'interrupted':
      return 'interrupted';
    case 'invalid':
      return 'internal_failure';
    case 'failure':
      return 'transport_failure';
  }
}

async function readConnection(
  host: ExecutorHost,
  filter: HostToolFilter,
  remaining: () => number,
): Promise<HostConnection> {
  let connection: HostConnection | null;
  try {
    connection = await host.getConnection(filter, Math.max(1, remaining()));
  } catch (error) {
    if (error instanceof HostOperationError)
      refused(toDiscoveryFailure(error), 'connection read failed');
    throw error;
  }
  if (connection === null)
    refused('connection_unknown', 'connection does not exist for this target');
  return connection;
}

/** Observe one target's catalog freshly under the application bounds. */
export async function runDiscovery(
  host: ExecutorHost,
  target: ServicePluginTarget,
  options: ServicePluginDiscoveryOptions,
): Promise<ServicePluginCatalog> {
  const deadlineMs = discoveryDeadlineMs(options.deadlineMs);
  if (deadlineMs <= 0) refused('deadline_exceeded', 'deadline is already exhausted');
  if (options.signal?.aborted === true) refused('interrupted', 'caller cancelled before discovery');
  if (target.integrationId.length === 0 || target.connectionId.length === 0) {
    refused('connection_unknown', 'target connection is not addressable');
  }

  const startedAt = Date.now();
  const remaining = (): number => deadlineMs - (Date.now() - startedAt);
  const filter: HostToolFilter = {
    integrationId: target.integrationId,
    connectionId: target.connectionId,
    owner: target.owner,
  };

  await readConnection(host, filter, remaining);

  // One bounded upstream re-discovery. A failed refresh must never fall back
  // to whatever the persisted snapshot happens to contain.
  try {
    await host.refreshConnection(filter, Math.max(1, remaining()));
  } catch (error) {
    if (error instanceof HostOperationError) {
      refused(toDiscoveryFailure(error), 'fresh catalog discovery failed');
    }
    throw error;
  }
  const connection = await readConnection(host, filter, remaining);
  if (isIncomplete(connection)) {
    refused(
      'catalog_incomplete',
      'the upstream tool listing did not complete; no catalog is authoritative',
    );
  }

  let observed: readonly HostTool[];
  try {
    observed = await host.listTools(filter, Math.max(1, remaining()));
  } catch (error) {
    if (error instanceof HostOperationError)
      refused(toDiscoveryFailure(error), 'tool discovery failed');
    throw error;
  }
  // The deadline is a wall-clock bound, including schema backfill inside the
  // listing read; a late answer is refused rather than published.
  if (remaining() <= 0) refused('deadline_exceeded', 'discovery exceeded its deadline');
  if (observed.length > SERVICE_PLUGIN_MAX_TOOLS) {
    refused(
      'too_many_tools',
      `catalog has ${observed.length} tools, over the ${SERVICE_PLUGIN_MAX_TOOLS}-tool cap`,
    );
  }

  const tools: ServicePluginTool[] = [];
  for (const tool of observed) {
    const converted = toTool(tool);
    if (converted === null) {
      refused('internal_failure', 'a discovered tool schema is not representable as JSON');
    }
    tools.push(converted);
  }
  tools.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const payload = canonicalJson(tools as unknown as ServicePluginJson);
  if (utf8Bytes(payload) > SERVICE_PLUGIN_MAX_DISCOVERY_BYTES) {
    refused(
      'discovery_too_large',
      `catalog payload exceeds the ${SERVICE_PLUGIN_MAX_DISCOVERY_BYTES}-byte cap`,
    );
  }

  return {
    target: { ...target },
    tools,
    schemaDigest: sha256Hex(payload),
    account: readIdentity(connection),
    discoveredAt: new Date().toISOString(),
    completeness: 'complete',
  };
}
