/**
 * Setup seam over the pinned plugins: integration registration, static/OAuth
 * connection creation.
 *
 * SDK-free by design: it receives the `BoundaryAccess` accessors and passes
 * already-branded values back, so this module type-checks normally even though
 * the SDK's own declarations resolve to `any` in the repository's NodeNext
 * configuration (see `sdk-boundary.ts`).
 */
import type { BoundaryAccess } from './sdk-access.js';
import type {
  HostConnectionInput,
  HostIntegrationInput,
  HostMcpInput,
  HostOAuthConnectionInput,
  HostOpenApiInput,
  HostSetupOperations,
} from './host-types.js';
import { HostOperationError, readOAuthStart, readSlug } from './host-types.js';

export function createSetupOperations(access: BoundaryAccess): HostSetupOperations {
  const call = (effect: unknown, what: string): Promise<unknown> => access.run(effect, what);

  return {
    async registerIntegration(input: HostIntegrationInput) {
      const handle = access.extension(input.pluginId);
      if (handle.register === undefined) {
        throw new HostOperationError(
          'invalid',
          'missing_handler',
          `plugin "${input.pluginId}" has no register`,
        );
      }
      await call(
        handle.register({
          slug: access.integrationSlug(input.slug),
          description: input.description,
          config: input.config,
        }),
        'plugin.register',
      );
    },

    async installOpenApi(input: HostOpenApiInput) {
      const handle = access.extension('openapi');
      if (handle.addSpec === undefined) {
        throw new HostOperationError('invalid', 'missing_handler', 'openapi plugin has no addSpec');
      }
      const added = await call(
        handle.addSpec({
          slug: access.integrationSlug(input.integrationId),
          name: input.name,
          description: input.description,
          spec: { kind: 'blob', value: input.specJson },
          authenticationTemplate: input.authTemplates,
        }),
        'openapi.addSpec',
      );
      return readSlug(added);
    },

    async installMcp(input: HostMcpInput) {
      // Pin the transport: stdio would execute a local process, which RC2's
      // catalog never permits. Endpoint/transport are service-supplied, never
      // model-supplied (Task 5 obligation).
      if (input.remoteTransport !== 'streamable-http') {
        throw new HostOperationError(
          'invalid',
          'unsupported_transport',
          'only streamable-http MCP endpoints may be installed',
        );
      }
      const handle = access.extension('mcp');
      if (handle.addServer === undefined) {
        throw new HostOperationError('invalid', 'missing_handler', 'mcp plugin has no addServer');
      }
      const added = await call(
        handle.addServer({
          name: input.name,
          description: input.description,
          endpoint: input.endpoint,
          remoteTransport: input.remoteTransport,
          authenticationTemplate: input.authTemplates,
        }),
        'mcp.addServer',
      );
      return readSlug(added);
    },

    async createConnection(input: HostConnectionInput) {
      const connections = asRecord(asRecord(access.executor).connections);
      const create = asCallable(connections.create);
      if (create === null) {
        throw new HostOperationError(
          'invalid',
          'missing_handler',
          'executor has no connections.create',
        );
      }
      await call(
        create({
          owner: input.owner,
          name: access.connectionName(input.connectionId),
          integration: access.integrationSlug(input.integrationId),
          template: access.authTemplateSlug(input.template),
          value: input.value,
        }),
        'connections.create',
      );
    },

    async createOAuthConnection(input: HostOAuthConnectionInput) {
      const oauth = asRecord(asRecord(access.executor).oauth);
      const start = asCallable(oauth.start);
      const complete = asCallable(oauth.complete);
      if (start === null || complete === null) {
        throw new HostOperationError('invalid', 'missing_handler', 'executor has no oauth service');
      }
      const started = readOAuthStart(
        await call(
          start({
            client: access.oauthClientSlug(input.clientSlug),
            clientOwner: 'user',
            owner: 'user',
            name: access.connectionName(input.connectionId),
            integration: access.integrationSlug(input.integrationId),
            template: access.authTemplateSlug(input.template),
          }),
          'oauth.start',
        ),
      );
      // TEST-ONLY browser stand-in for the OAuth authorization redirect; product
      // code never supplies this fetch, so a shipped path can never bypass the
      // guarded transport client.
      const oauthSetupFetch = access.oauthSetupFetch;
      if (oauthSetupFetch === null) {
        throw new HostOperationError(
          'invalid',
          'oauth_setup_unavailable',
          'OAuth setup is test-only and requires an explicit browser stand-in',
        );
      }
      const authorization = await oauthSetupFetch(started.authorizationUrl, {
        redirect: 'manual',
      });
      const location = authorization.headers.get('location');
      const code = location === null ? null : new URL(location).searchParams.get('code');
      if (code === null) {
        throw new HostOperationError(
          'invalid',
          'oauth_code_missing',
          'authorization server returned no code',
        );
      }
      await call(complete({ state: started.state, code }), 'oauth.complete');
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asCallable(value: unknown): ((input: unknown) => unknown) | null {
  return typeof value === 'function' ? (value as (input: unknown) => unknown) : null;
}
