/**
 * Bounded discovery.
 *
 * Fail-closed catalog observation: any refusal or failure raises
 * `ServicePluginDiscoveryRefusedError`, so the caller keeps its previous
 * catalog and its previous grants. The caps are enforced on the observed
 * result (tool count, canonical payload bytes), while the guarded HTTP layer
 * separately caps each response stream, so a plugin cannot return an
 * unbounded catalog.
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

import type { ExecutorHost, HostConnection, HostTool } from './host-types.js';
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

/** Observe one target's catalog under the application bounds. */
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

  let connection: HostConnection | null;
  try {
    connection = await host.getConnection(
      {
        integrationId: target.integrationId,
        connectionId: target.connectionId,
        owner: target.owner,
      },
      Math.max(1, remaining()),
    );
  } catch (error) {
    if (error instanceof HostOperationError)
      refused(toDiscoveryFailure(error), 'connection read failed');
    throw error;
  }
  if (connection === null)
    refused('connection_unknown', 'connection does not exist for this target');

  let observed;
  try {
    observed = await host.listTools(
      {
        integrationId: target.integrationId,
        connectionId: target.connectionId,
        owner: target.owner,
      },
      Math.max(1, remaining()),
    );
  } catch (error) {
    if (error instanceof HostOperationError)
      refused(toDiscoveryFailure(error), 'tool discovery failed');
    throw error;
  }
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
  };
}
