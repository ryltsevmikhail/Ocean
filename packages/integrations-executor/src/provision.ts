/**
 * Lazy, consent-ordered installation of a declarative plugin connection.
 *
 * `open()` accepts a pure host-supplied provisioner. The adapter installs the
 * integration (network-free) and creates the named connection only when
 * `discover()` is called — which Ocean only does after the owner's single-use
 * metadata-discovery consent. That one `connections.create` performs the
 * upstream connect/tool-sync, so it is part of the consented discovery pass and
 * is counted/attributed as discovery traffic, never as a business call.
 *
 * Plain types only: no Executor/Effect type appears here.
 */

import { ServicePluginDiscoveryRefusedError } from '@runnets/application';
import type { ServicePluginTarget } from '@runnets/application';

import { HostOperationError } from './host-types.js';
import type {
  ExecutorProvision,
  ExecutorProvisionAuthTemplate,
  ProvisioningOptions,
} from './provision-types.js';
export type {
  ExecutorConnectionProvisioner,
  ExecutorMcpProvision,
  ExecutorOpenApiProvision,
  ExecutorProvision,
  ExecutorProvisionAuthTemplate,
  ExecutorProvisionConnection,
} from './provision-types.js';
import { bounded, exactKeys, httpsEndpoint, SETUP_CREDENTIAL_REFERENCE } from './setup-input.js';

/** Exact ids the SDK preserves verbatim (no normalisation/prefixing). */
const SETUP_CONNECTION_ID = /^[a-z][A-Za-z0-9]{0,63}$/;

export interface Provisioning {
  /** Idempotent per target; performs at most one upstream connect per connection. */
  ensure(target: ServicePluginTarget): Promise<void>;
}

/** Structural host subset the provisioner needs; matches the adapter host. */
interface ProvisionHost {
  installMcp(input: {
    readonly name: string;
    readonly description: string;
    readonly endpoint: string;
    readonly remoteTransport: 'streamable-http';
    readonly versionNegotiation?: 'legacy';
    readonly authTemplates: readonly unknown[];
  }): Promise<string>;
  installOpenApi(input: {
    readonly integrationId: string;
    readonly name: string;
    readonly description: string;
    readonly specJson: string;
    readonly authTemplates: readonly unknown[];
  }): Promise<string>;
  createConnection(input: {
    readonly integrationId: string;
    readonly connectionId: string;
    readonly owner: 'user' | 'org';
    readonly template: string;
    readonly value: string;
  }): Promise<void>;
  /** Bounded local read: confirms the created row is addressable before discovery. */
  getConnection(
    input: {
      readonly integrationId: string;
      readonly connectionId: string;
      readonly owner: 'user' | 'org';
    },
    deadlineMs: number,
  ): Promise<unknown>;
}

function refusal(
  code: ConstructorParameters<typeof ServicePluginDiscoveryRefusedError>[0],
  message: string,
): never {
  throw new ServicePluginDiscoveryRefusedError(code, message);
}

function validateTemplate(value: unknown): ExecutorProvisionAuthTemplate {
  const template = value as ExecutorProvisionAuthTemplate;
  exactKeys(
    template,
    template.headers === undefined ? ['slug', 'type'] : ['slug', 'type', 'headers'],
    'auth template',
  );
  return {
    slug: bounded(template.slug, 64, 'auth template slug'),
    type: bounded(template.type, 64, 'auth template type'),
    ...(template.headers === undefined ? {} : { headers: template.headers }),
  };
}

function validateDescriptor(
  target: ServicePluginTarget,
  descriptor: ExecutorProvision,
  allowedOrigins: readonly string[],
): ExecutorProvision {
  if (descriptor.integrationId !== target.integrationId)
    refusal('internal_failure', 'provisioned integration does not match the target');
  // The SDK normalises an unsafe name instead of refusing it; require an exactly
  // addressable id so a silent rename can never make discovery read the wrong row.
  if (!SETUP_CONNECTION_ID.test(target.connectionId))
    refusal('connection_unknown', 'target connection id is not SDK-addressable');
  if (descriptor.connection === undefined)
    refusal('internal_failure', 'provisioned connection is missing');
  exactKeys(descriptor.connection, ['template', 'credentialReference'], 'connection');
  const template = bounded(descriptor.connection.template, 64, 'connection template');
  const reference = descriptor.connection.credentialReference;
  if (typeof reference !== 'string' || !SETUP_CREDENTIAL_REFERENCE.test(reference))
    refusal('internal_failure', 'credential reference must be an environment variable NAME');
  if (!Array.isArray(descriptor.authTemplates) || descriptor.authTemplates.length === 0)
    refusal('internal_failure', 'at least one auth template is required');
  const authTemplates = descriptor.authTemplates.map(validateTemplate);
  if (!authTemplates.some((candidate) => candidate.slug === template))
    refusal('internal_failure', 'connection template is not declared');
  if (descriptor.kind === 'mcp') {
    if (descriptor.versionNegotiation !== undefined && descriptor.versionNegotiation !== 'legacy')
      refusal('internal_failure', 'unsupported MCP negotiation policy');
    return {
      kind: 'mcp',
      integrationId: descriptor.integrationId,
      description: bounded(descriptor.description, 4096, 'description'),
      endpoint: httpsEndpoint(descriptor.endpoint, allowedOrigins),
      ...(descriptor.versionNegotiation === undefined
        ? {}
        : { versionNegotiation: descriptor.versionNegotiation }),
      authTemplates,
      connection: { template, credentialReference: reference },
    };
  }
  return {
    kind: 'openapi',
    integrationId: descriptor.integrationId,
    name: bounded(descriptor.name, 128, 'name'),
    description: bounded(descriptor.description, 4096, 'description'),
    specJson: bounded(descriptor.specJson, 2 * 1024 * 1024, 'specJson'),
    authTemplates,
    connection: { template, credentialReference: reference },
  };
}

/** Create one lazy provisioner bound to a created adapter host. */
export function createProvisioning(
  host: ProvisionHost,
  options: ProvisioningOptions,
): Provisioning {
  const slugs = new Map<string, string>();
  const provisioned = new Set<string>();
  return {
    async ensure(target: ServicePluginTarget): Promise<void> {
      const key = `${target.owner}\u0000${target.integrationId}\u0000${target.connectionId}`;
      if (provisioned.has(key)) return;
      let descriptor: ExecutorProvision | null;
      try {
        descriptor = await options.provision({ ...target });
      } catch {
        refusal('transport_failure', 'plugin connection provisioning failed');
      }
      if (descriptor === null)
        refusal('connection_unknown', 'no provisionable connection for this target');
      let validated: ExecutorProvision;
      try {
        validated = validateDescriptor(target, descriptor, options.allowedOrigins);
      } catch (error) {
        if (error instanceof ServicePluginDiscoveryRefusedError) throw error;
        refusal('internal_failure', 'plugin connection descriptor is invalid');
      }
      let slug = slugs.get(validated.integrationId);
      if (slug === undefined) {
        try {
          slug =
            validated.kind === 'mcp'
              ? await host.installMcp({
                  // The SDK derives the integration slug from this name; use the
                  // stable Ocean plugin id so addressed targets resolve exactly.
                  name: validated.integrationId,
                  description: validated.description,
                  endpoint: validated.endpoint,
                  remoteTransport: 'streamable-http',
                  ...(validated.versionNegotiation === undefined
                    ? {}
                    : { versionNegotiation: validated.versionNegotiation }),
                  authTemplates: validated.authTemplates,
                })
              : await host.installOpenApi({
                  integrationId: validated.integrationId,
                  name: validated.name,
                  description: validated.description,
                  specJson: validated.specJson,
                  authTemplates: validated.authTemplates,
                });
        } catch (error) {
          refusal(
            error instanceof HostOperationError ? 'transport_failure' : 'internal_failure',
            'plugin integration could not be installed',
          );
        }
        slugs.set(validated.integrationId, slug);
      }
      const value = options.resolveCredential(validated.connection.credentialReference);
      if (value === null || value.trim() === '' || value.length > 4096)
        refusal(
          'transport_failure',
          'the environment reference for this plugin connection is not available',
        );
      try {
        await host.createConnection({
          integrationId: slug,
          connectionId: target.connectionId,
          owner: target.owner,
          template: validated.connection.template,
          value,
        });
      } catch {
        refusal('transport_failure', 'plugin connection could not be created');
      }
      // The SDK may report creation before the row is readable; confirm the exact
      // addressed connection locally (no upstream request) before discovery reads it.
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          if (
            (await host.getConnection(
              {
                integrationId: target.integrationId,
                connectionId: target.connectionId,
                owner: target.owner,
              },
              1_000,
            )) !== null
          ) {
            provisioned.add(key);
            return;
          }
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      refusal('transport_failure', 'provisioned connection is not readable yet');
    },
  };
}
