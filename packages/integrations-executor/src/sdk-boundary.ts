/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return --
   The pinned @executor-js declaration chain imports @executor-js/fumadb, whose
   declaration files use extensionless relative imports. Under the repository's
   NodeNext + skipLibCheck configuration those imports fail to resolve, so every
   type re-exported from `@executor-js/sdk/core` is an error type (`any`) even
   though runtime values are unaffected. This module is the deliberate boundary:
   it validates every value that leaves the SDK, and every consumer above it is
   fully typed against Ocean's plain types. `tsc` still type-checks this file's
   own logic; only the unavailable third-party types are treated as untyped. */
/**
 * The one module that performs SDK calls, converts their results into the
 * adapter's plain shapes and owns the guarded HTTP + elicitation wiring.
 *
 * Everything here is internal. Values received from the SDK are `unknown` and
 * are narrowed with runtime checks before they reach the rest of the adapter,
 * so a drifted bundle cannot silently change the meaning of a result.
 */
import { Effect, Exit } from 'effect';

import { mcpPlugin } from '@executor-js/plugin-mcp/core';
import { openApiPlugin } from '@executor-js/plugin-openapi/core';
import * as sdk from '@executor-js/sdk/core';

import type { ExecutorDispatchExit } from './dispatch.js';
import { createGuardedHttp } from './guarded-fetch.js';
import type {
  ExecutorHost,
  ExecutorHostOptions,
  HostConnection,
  HostExecuteInput,
  HostTool,
  HostToolFilter,
} from './host-types.js';
import {
  HostOperationError,
  abortWhenSignalled,
  hostErrorFromCause,
  toDispatchExit,
} from './host-types.js';
import { createSetupOperations } from './sdk-setup.js';

export interface ExtensionHandle {
  readonly register?: (input: unknown) => unknown;
  readonly addSpec?: (input: unknown) => unknown;
  readonly addServer?: (input: unknown) => unknown;
}

/** Shared accessors handed to the (SDK-free) setup module. */
export interface BoundaryAccess {
  readonly executor: unknown;
  run(effect: unknown, what: string): Promise<unknown>;
  extension(pluginId: string): ExtensionHandle;
  integrationSlug(value: string): unknown;
  connectionName(value: string): unknown;
  authTemplateSlug(value: string): unknown;
  oauthClientSlug(value: string): unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asEffect(value: unknown): Effect.Effect<unknown, unknown> {
  return value as Effect.Effect<unknown, unknown>;
}

function asCallable(value: unknown): ((input: unknown) => unknown) | null {
  return typeof value === 'function' ? (value as (input: unknown) => unknown) : null;
}

function toHostTool(value: unknown): HostTool {
  const tool = asRecord(value);
  const name = typeof tool.name === 'string' ? tool.name : '';
  const address = typeof tool.address === 'string' ? tool.address : '';
  if (name.length === 0 || address.length === 0) {
    throw new HostOperationError(
      'invalid',
      'invalid_tool',
      'tools.list returned an unaddressable tool',
    );
  }
  return {
    address,
    name,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: tool.inputSchema,
  };
}

function toHostConnection(value: unknown): HostConnection {
  const connection = asRecord(value);
  const rawHealth = connection.lastHealth;
  const health = asRecord(rawHealth);
  return {
    identityLabel: typeof connection.identityLabel === 'string' ? connection.identityLabel : null,
    lastHealth:
      rawHealth === null || rawHealth === undefined
        ? null
        : {
            status: typeof health.status === 'string' ? health.status : 'unknown',
            identity: typeof health.identity === 'string' ? health.identity : null,
          },
  };
}

function createAccess(executor: unknown, run: BoundaryAccess['run']): BoundaryAccess {
  return {
    executor,
    run,
    extension(pluginId) {
      const handle = asRecord(executor)[pluginId];
      if (typeof handle === 'object' && handle !== null) return handle;
      throw new HostOperationError(
        'invalid',
        'missing_plugin',
        `plugin extension "${pluginId}" is unavailable`,
      );
    },
    integrationSlug: (value) => sdk.IntegrationSlug.make(value),
    connectionName: (value) => sdk.ConnectionName.make(value),
    authTemplateSlug: (value) => sdk.AuthTemplateSlug.make(value),
    oauthClientSlug: (value) => sdk.OAuthClientSlug.make(value),
  };
}

export async function createExecutorHost(options: ExecutorHostOptions): Promise<ExecutorHost> {
  const guarded = createGuardedHttp({
    allowedOrigins: options.allowedOrigins,
    ...(options.requestLimitBytes === undefined
      ? {}
      : { requestLimitBytes: options.requestLimitBytes }),
    ...(options.responseLimitBytes === undefined
      ? {}
      : { responseLimitBytes: options.responseLimitBytes }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
  });

  // The SDK's own approval gate asks with `source: "policy"`: the caller has
  // already recorded consent for this exact tool call through Ocean's journal,
  // so the host accepts it. Anything a TOOL asks for mid-call is never granted
  // (an absent source is treated as tool-originated), so extra actions fail
  // closed.
  const onElicitation = (context: unknown): unknown => {
    const record = asRecord(context);
    const request = asRecord(record.request);
    const tag = typeof request._tag === 'string' ? request._tag : 'unknown';
    const source = record.source === 'policy' ? 'policy' : 'tool';
    return Effect.sync(() => {
      options.onElicitationRequest?.(tag, source);
      return { action: source === 'policy' ? ('accept' as const) : ('decline' as const) };
    });
  };

  const plugins: readonly unknown[] = options.plugins ?? [openApiPlugin(), mcpPlugin()];
  const executor: unknown = await Effect.runPromise(
    sdk.createExecutor({
      tenant: sdk.Tenant.make(options.tenantId),
      subject: sdk.Subject.make(options.subjectId),
      plugins,
      onElicitation,
      httpClientLayer: guarded.httpClientLayer,
      fetch: guarded.fetch,
      ...(options.redirectUri === undefined ? {} : { redirectUri: options.redirectUri }),
      ...(options.providers === undefined ? {} : { providers: options.providers }),
      ...(options.firstPartyOAuthClients === undefined
        ? {}
        : { firstPartyOAuthClients: options.firstPartyOAuthClients }),
    }),
  );
  const run = async (effect: unknown, what: string): Promise<unknown> => {
    const exit = await Effect.runPromiseExit(asEffect(effect));
    if (Exit.isSuccess(exit)) return exit.value;
    const error = hostErrorFromCause(exit.cause);
    throw new HostOperationError(error.failure, error.tag, `${what}: ${error.message}`);
  };

  const access = createAccess(executor, run);
  const setup = createSetupOperations(access);
  const executorRecord = asRecord(executor);

  const toolFilter = (filter: HostToolFilter): Record<string, unknown> => ({
    integration: access.integrationSlug(filter.integrationId),
    owner: filter.owner,
    ...(filter.connectionId === undefined
      ? {}
      : { connection: access.connectionName(filter.connectionId) }),
  });

  const listTools = async (
    filter: HostToolFilter,
    deadlineMs: number,
  ): Promise<readonly HostTool[]> => {
    const tools = asRecord(executorRecord.tools);
    if (typeof tools.list !== 'function') {
      throw new HostOperationError('invalid', 'missing_handler', 'executor has no tools.list');
    }
    const listed = await run(
      asEffect(tools.list(toolFilter(filter))).pipe(Effect.timeout(deadlineMs)),
      'tools.list',
    );
    if (!Array.isArray(listed)) {
      throw new HostOperationError('invalid', 'invalid_result', 'tools.list returned a non-array');
    }
    const mapped = listed.map(toHostTool);
    const schemaOf = asCallable(tools.schema);
    if (schemaOf === null) return mapped;
    // Some plugins persist the tool row without its input schema and resolve
    // the full view on demand; discovery needs the schema for its digest.
    return Promise.all(
      mapped.map(async (tool) => {
        if (tool.inputSchema !== undefined && tool.inputSchema !== null) return tool;
        const view = asRecord(await run(asEffect(schemaOf(tool.address)), 'tools.schema'));
        return { ...tool, inputSchema: view.inputSchema };
      }),
    );
  };

  const getConnection = async (
    filter: HostToolFilter,
    deadlineMs: number,
  ): Promise<HostConnection | null> => {
    const connections = asRecord(executorRecord.connections);
    if (typeof connections.get !== 'function') {
      throw new HostOperationError('invalid', 'missing_handler', 'executor has no connections.get');
    }
    const connection = await run(
      asEffect(
        connections.get({
          owner: filter.owner,
          name: access.connectionName(filter.connectionId ?? ''),
          integration: access.integrationSlug(filter.integrationId),
        }),
      ).pipe(Effect.timeout(deadlineMs)),
      'connections.get',
    );
    return connection === null ? null : toHostConnection(connection);
  };

  const execute = async (input: HostExecuteInput): Promise<ExecutorDispatchExit> => {
    if (typeof executorRecord.execute !== 'function') {
      throw new HostOperationError('invalid', 'missing_handler', 'executor has no execute');
    }
    const dispatch = asEffect(
      executorRecord.execute(sdk.ToolAddress.make(input.address), input.arguments),
    ).pipe(Effect.timeout(input.deadlineMs));
    const raced =
      input.signal === undefined
        ? dispatch
        : Effect.raceFirst(dispatch, abortWhenSignalled(input.signal));
    return toDispatchExit(await Effect.runPromiseExit(raced));
  };

  return {
    guarded,
    httpClientLayer: guarded.httpClientLayer,
    listTools,
    getConnection,
    execute,
    ...setup,
    async close() {
      if (typeof executorRecord.close !== 'function') return;
      const exit = await Effect.runPromiseExit(asEffect(executorRecord.close()));
      if (Exit.isFailure(exit)) throw hostErrorFromCause(exit.cause);
    },
  };
}
