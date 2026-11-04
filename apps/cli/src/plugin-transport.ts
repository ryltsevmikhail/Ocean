/**
 * Host composition of the qualified Executor transport — the one place in the
 * product that enables plugin execution.
 *
 * Enabling is justified by the accepted Task 4 qualification (one business
 * request per allowed call, including after 401; dropped replies classified
 * uncertain; guarded 1 MiB/4 MiB/30 s limits) and this task's own counter gates
 * (one business request on the allowed path, zero on every denial) — see
 * `task-06-report.md`. Execution is requested only here, and only after the
 * pinned patched chunk is verified; any refusal falls back to the fail-closed
 * disabled transport so a broken adapter never dispatches.
 *
 * The declarative connection is provisioned lazily inside `discover()`, which
 * Ocean only calls after the owner's single-use metadata-discovery consent, so
 * the one upstream connect/tool-sync belongs to that consented pass.
 */

import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';
import type { ServicePluginTransportPort } from '@runnets/application';
import type {
  ExecutorProvision,
  ExecutorProvisionAuthTemplate,
} from '@runnets/integrations-executor';
import { DisabledPluginTransport } from './plugin-runtime.js';

/** Declarative bearer template for the frozen GitHub read-issues card. */
export const GITHUB_MCP_AUTH_TEMPLATES: readonly ExecutorProvisionAuthTemplate[] = [
  {
    slug: 'bearer',
    type: 'apiKey',
    headers: { Authorization: ['Bearer ', { type: 'variable', name: 'token' }] },
  },
];

/** Durable connection facts a consented discovery may provision. */
export interface PluginConnectionFacts {
  readonly pluginId: string;
  readonly endpoint: string;
  /** Environment variable NAME only; the value never crosses this module. */
  readonly credentialReference: string;
}

export interface ExecutorPluginTransportOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolved lazily: the runtime stores exist only after the profile opens. */
  readonly connection: (connectionId: string) => PluginConnectionFacts | null;
  /**
   * Test-only deterministic local endpoint (HTTP loopback). The real adapter is
   * qualified against local MCP/OpenAPI servers through this seam; a
   * non-loopback override is refused before any host is constructed.
   */
  readonly endpointOverride?: string;
  readonly tenantId?: string;
  readonly subjectId?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function shippedEndpoint(): string {
  const entry = SHIPPED_PLUGIN_CATALOG.entries[0];
  if (entry === undefined) throw Error('plugin_catalog_empty');
  return entry.manifest.endpoint;
}

/** Open the qualified transport with execution enabled, or a disabled one. */
export interface HostPluginTransportInput {
  /** Test-only deterministic transport injection. */
  readonly transport?: ServicePluginTransportPort | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly endpointOverride?: string | undefined;
  /** Durable connection rows, resolved lazily after the profile opens. */
  readonly connections: () => { get(id: string): PluginConnectionFacts | null } | undefined;
}

/**
 * The local runtime host's transport: an injected deterministic transport or the
 * real qualified adapter. Connection facts are read lazily because the runtime
 * stores exist only after the profile is opened.
 */
export async function hostPluginTransport(
  input: HostPluginTransportInput,
): Promise<ServicePluginTransportPort> {
  if (input.transport !== undefined) return input.transport;
  return openExecutorPluginTransport({
    env: input.env,
    connection: (connectionId) => {
      const row = input.connections()?.get(connectionId);
      return row === null || row === undefined
        ? null
        : {
            pluginId: row.pluginId,
            endpoint: row.endpoint,
            credentialReference: row.credentialReference,
          };
    },
    ...(input.endpointOverride === undefined ? {} : { endpointOverride: input.endpointOverride }),
  });
}

export async function openExecutorPluginTransport(
  options: ExecutorPluginTransportOptions,
): Promise<ServicePluginTransportPort> {
  const endpoint = options.endpointOverride ?? shippedEndpoint();
  if (options.endpointOverride !== undefined) {
    let host = '';
    try {
      host = new URL(endpoint).hostname;
    } catch {
      return new DisabledPluginTransport('plugin_endpoint_untrusted');
    }
    if (!LOOPBACK.has(host)) return new DisabledPluginTransport('plugin_endpoint_untrusted');
  }
  let origin: string;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    return new DisabledPluginTransport('plugin_endpoint_untrusted');
  }
  try {
    const { ExecutorServicePluginTransport } = await import('@runnets/integrations-executor');
    return await ExecutorServicePluginTransport.open({
      tenantId: options.tenantId ?? 'ocean-owner',
      subjectId: options.subjectId ?? 'ocean-owner',
      allowedOrigins: [origin],
      enableExecution: true,
      resolveCredential: (reference) => {
        const value = options.env[reference];
        return typeof value === 'string' && value.trim() !== '' ? value : null;
      },
      provision: (target): ExecutorProvision | null => {
        const facts = options.connection(target.connectionId);
        if (facts === null || facts.pluginId !== target.integrationId) return null;
        return {
          kind: 'mcp',
          integrationId: target.integrationId,
          description: 'GitHub issues (read-only remote MCP server)',
          endpoint: options.endpointOverride ?? facts.endpoint,
          authTemplates: GITHUB_MCP_AUTH_TEMPLATES,
          connection: { template: 'bearer', credentialReference: facts.credentialReference },
        };
      },
    });
  } catch {
    // Pinned-chunk/option refusals mean the adapter is not qualified: stay disabled.
    return new DisabledPluginTransport('executor_unavailable');
  }
}
