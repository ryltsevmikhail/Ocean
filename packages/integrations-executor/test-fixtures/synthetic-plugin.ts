/**
 * Synthetic Executor plugin + credential provider for the dispatch-counter
 * tests. It mirrors the qualification probe: the plugin performs a real
 * loopback business POST and reports a 401 as the SDK's
 * `connection_rejected` tool failure, which is exactly the trigger the patched
 * reactive OAuth replay used to react to.
 *
 * The plugin's own business call uses the test's global fetch; the token
 * endpoint traffic goes through the SDK's guarded HTTP layer. The guarded
 * transport itself is exercised by the real OpenAPI/MCP suites.
 */
import { Effect } from 'effect';
import { ProviderKey, ToolResult, authToolFailure, definePlugin } from '@executor-js/sdk/core';

export type SyntheticScenario =
  'ok' | 'oauth401' | 'static401' | 'double401' | 'drop' | 'slow' | 'elicit';

export interface SyntheticCounts {
  business: number;
  token: number;
  grants: string[];
  elicitDeclined: number;
}

export const createSyntheticCounts = (): SyntheticCounts => ({
  business: 0,
  token: 0,
  grants: [],
  elicitDeclined: 0,
});

export interface SyntheticPluginInput {
  readonly scenario: SyntheticScenario;
  readonly businessBase: string;
  readonly tokenBase: string;
  readonly counts: SyntheticCounts;
  /** Test knob: replace the resolved catalog (discovery-cap tests). */
  readonly catalog?: readonly unknown[];
}

const tools = [
  {
    name: 'write_thing',
    description: 'Synthetic business write for the RC2 qualification probe.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
];

export function syntheticPlugin(input: SyntheticPluginInput): unknown {
  const { scenario, businessBase, tokenBase, counts, catalog } = input;

  const businessResult = (credential: { value: string }) =>
    Effect.tryPromise({
      try: () =>
        fetch(`${businessBase}/things`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${credential.value}`,
          },
          body: '{}',
        }),
      catch: (cause) => new Error(`transport: ${String(cause)}`),
    }).pipe(
      Effect.match({
        onFailure: (error) =>
          ToolResult.fail({
            code: 'upstream_unreachable',
            message: `transport failure: ${error.message}`,
            retryable: false,
          }),
        onSuccess: (response) =>
          response.status === 401
            ? authToolFailure({
                code: 'connection_rejected',
                message: 'upstream rejected the credential with 401',
                status: 401,
              })
            : ToolResult.ok({ status: response.status }),
      }),
    );

  return definePlugin(() => ({
    id: 'probe-integration',
    storage: () => ({}),
    extension: (ctx: { core: { integrations: { register: (value: unknown) => unknown } } }) => ({
      register: (registration: unknown) => ctx.core.integrations.register(registration),
    }),
    describeAuthMethods: () => [
      {
        id: 'oauth',
        label: 'Probe OAuth',
        kind: 'oauth',
        template: 'oauth',
        oauth: {
          authorizationUrl: `${tokenBase}/authorize`,
          tokenUrl: `${tokenBase}/token`,
          scopes: ['read'],
        },
      },
      { id: 'token', label: 'API token', kind: 'apikey', template: 'token' },
    ],
    resolveTools: () => Effect.succeed({ tools: catalog ?? tools }),
    invokeTool: (invocation: {
      readonly credential: { readonly value: string };
      readonly elicit: (request: unknown) => Effect.Effect<unknown, unknown>;
    }) =>
      Effect.gen(function* () {
        if (scenario === 'elicit') {
          const outcome = yield* invocation
            .elicit({
              _tag: 'FormElicitation',
              message: 'the tool asks for an extra action',
              requestedSchema: { type: 'object', properties: {} },
            })
            .pipe(
              Effect.match({
                onFailure: () => 'declined' as const,
                onSuccess: () => 'answered' as const,
              }),
            );
          if (outcome === 'declined') counts.elicitDeclined += 1;
          return ToolResult.fail({
            code: outcome === 'declined' ? 'elicitation_declined' : 'elicitation_answered',
            message: `tool-originated elicitation was ${outcome}`,
          });
        }
        return yield* businessResult(invocation.credential);
      }),
  }))();
}

export interface MemoryProvider {
  readonly provider: unknown;
  readonly store: Map<string, string>;
}

export function memoryProvider(name = 'probe-memory'): MemoryProvider {
  const store = new Map<string, string>();
  const provider = {
    key: ProviderKey.make(name),
    writable: true,
    get: (id: string) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id: string, value: string) => Effect.sync(() => void store.set(String(id), value)),
    delete: (id: string) => Effect.sync(() => void store.delete(String(id))),
  };
  return { provider, store };
}
