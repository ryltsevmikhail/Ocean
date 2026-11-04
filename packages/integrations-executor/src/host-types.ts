/**
 * Internal host contract: plain shapes and failure mapping around the pinned
 * Executor SDK. Kept in its own module so the transport, the executor wiring
 * and the setup seam can share them without duplicating SDK type imports.
 */
import { Cause, Effect, Exit, Option } from 'effect';
import type { Layer } from 'effect';
import type { HttpClient } from 'effect/unstable/http';

import type { ExecutorDispatchExit } from './dispatch.js';
import type { GuardedHttp } from './guarded-fetch.js';

export type HostOwner = 'user' | 'org';

export interface HostTool {
  readonly address: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface HostConnection {
  readonly identityLabel: string | null;
  readonly lastHealth: { readonly status: string; readonly identity: string | null } | null;
}

export type HostOperationFailure = 'timeout' | 'interrupted' | 'failure' | 'invalid';

/** Typed failure from a host read/setup operation; the transport maps it. */
export class HostOperationError extends Error {
  readonly failure: HostOperationFailure;
  readonly tag: string;

  constructor(failure: HostOperationFailure, tag: string, message: string) {
    super(message);
    this.name = 'HostOperationError';
    this.failure = failure;
    this.tag = tag;
  }
}

export interface ExecutorHostOptions {
  readonly tenantId: string;
  readonly subjectId: string;
  /** Exact origins the transport may talk to (guarded HTTP). */
  readonly allowedOrigins: readonly string[];
  readonly requestLimitBytes?: number;
  readonly responseLimitBytes?: number;
  readonly deadlineMs?: number;
  /**
   * Defaults to the two pinned plugins; tests inject synthetic ones. Typed
   * `unknown` because the pinned SDK's declaration chain resolves to `any`
   * under the repo's NodeNext configuration (see `sdk-boundary.ts`); the
   * boundary validates what it passes to the SDK.
   */
  readonly plugins?: readonly unknown[];
  readonly providers?: readonly unknown[];
  readonly firstPartyOAuthClients?: readonly unknown[];
  /** OAuth callback URL; only set by the OAuth counter tests (not RC2 product). */
  readonly redirectUri?: string;
  /** Test observer for the decline-everything elicitation policy. */
  readonly onElicitationRequest?: (requestTag: string, source: string) => void;
}

export interface HostToolFilter {
  readonly integrationId: string;
  readonly owner: HostOwner;
  readonly connectionId?: string;
}

export interface HostExecuteInput {
  readonly address: string;
  readonly arguments: unknown;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

export interface HostOpenApiInput {
  readonly integrationId: string;
  readonly name: string;
  readonly description: string;
  /** Inline OpenAPI document, already serialized JSON. */
  readonly specJson: string;
  readonly authTemplates: readonly unknown[];
}

export interface HostMcpInput {
  readonly name: string;
  readonly description: string;
  readonly endpoint: string;
  readonly remoteTransport: string;
  readonly authTemplates: readonly unknown[];
}

export interface HostConnectionInput {
  readonly integrationId: string;
  readonly connectionId: string;
  readonly owner: HostOwner;
  readonly template: string;
  readonly value: string;
}

export interface HostOAuthConnectionInput {
  readonly integrationId: string;
  readonly connectionId: string;
  readonly template: string;
  /** `first-party:<name>` slug registered on the executor. */
  readonly clientSlug: string;
}

export interface HostIntegrationInput {
  readonly pluginId: string;
  readonly slug: string;
  readonly description: string;
  readonly config: unknown;
}

/** Setup operations used by the package's tests and by the future host layer. */
export interface HostSetupOperations {
  registerIntegration(input: HostIntegrationInput): Promise<void>;
  installOpenApi(input: HostOpenApiInput): Promise<string>;
  installMcp(input: HostMcpInput): Promise<string>;
  createConnection(input: HostConnectionInput): Promise<void>;
  createOAuthConnection(input: HostOAuthConnectionInput): Promise<void>;
}

export interface HostReadOperations {
  listTools(filter: HostToolFilter, deadlineMs: number): Promise<readonly HostTool[]>;
  getConnection(filter: HostToolFilter, deadlineMs: number): Promise<HostConnection | null>;
  execute(input: HostExecuteInput): Promise<ExecutorDispatchExit>;
}

export interface ExecutorHost extends HostReadOperations, HostSetupOperations {
  readonly guarded: GuardedHttp;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  close(): Promise<void>;
}

/** A failure branch of a raced abort; mapped to `uncertain` by the transport. */
export class DispatchAborted {
  readonly _tag = 'DispatchAborted' as const;
}

export interface OAuthStartResult {
  readonly authorizationUrl: string;
  readonly state: string;
}

export function tagOf(value: unknown): string {
  if (typeof value === 'object' && value !== null && '_tag' in value) {
    const tag = (value as { _tag?: unknown })._tag;
    if (typeof tag === 'string') return tag;
  }
  return typeof value;
}

export function hostErrorFromCause(cause: Cause.Cause<unknown>): HostOperationError {
  if (cause.reasons.some((reason) => Cause.isInterruptReason(reason))) {
    return new HostOperationError('interrupted', 'interrupted', 'operation interrupted');
  }
  const error = Cause.findErrorOption(cause);
  if (Option.isSome(error)) {
    const tag = tagOf(error.value);
    if (tag === 'TimeoutError') {
      return new HostOperationError('timeout', tag, 'operation exceeded its deadline');
    }
    return new HostOperationError('failure', tag, `operation failed (${tag})`);
  }
  return new HostOperationError('failure', 'defect', 'operation failed with a defect');
}

export function toDispatchExit(exit: Exit.Exit<unknown, unknown>): ExecutorDispatchExit {
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) {
    const tag = tagOf(error.value);
    if (tag === 'DispatchAborted') return { ok: false, outcome: 'interrupted', tag };
    if (tag === 'TimeoutError') return { ok: false, outcome: 'timeout', tag };
    return { ok: false, outcome: 'failure', tag };
  }
  if (exit.cause.reasons.some((reason) => Cause.isInterruptReason(reason))) {
    return { ok: false, outcome: 'interrupted', tag: 'interrupted' };
  }
  return { ok: false, outcome: 'failure', tag: 'defect' };
}

/** An effect that fails with `DispatchAborted` as soon as `signal` aborts. */
export function abortWhenSignalled(
  signal: AbortSignal | undefined,
): Effect.Effect<never, DispatchAborted> {
  if (signal === undefined) return Effect.never;
  return Effect.callback<never, DispatchAborted>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(new DispatchAborted()));
      return;
    }
    const onAbort = (): void => resume(Effect.fail(new DispatchAborted()));
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** Run a setup/read effect, converting any failure into a typed host error. */
export async function runEffect<A, E>(effect: Effect.Effect<A, E>, what: string): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const error = hostErrorFromCause(exit.cause);
  throw new HostOperationError(error.failure, error.tag, `${what}: ${error.message}`);
}

export function readSlug(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'slug' in value) {
    const slug: unknown = (value as { slug?: unknown }).slug;
    if (typeof slug === 'string') return slug;
  }
  throw new HostOperationError(
    'invalid',
    'invalid_result',
    'install did not return an integration slug',
  );
}

export function readOAuthStart(value: unknown): OAuthStartResult {
  if (typeof value === 'object' && value !== null) {
    const record = value as { authorizationUrl?: unknown; state?: unknown };
    if (typeof record.authorizationUrl === 'string' && typeof record.state === 'string') {
      return { authorizationUrl: record.authorizationUrl, state: record.state };
    }
  }
  throw new HostOperationError(
    'invalid',
    'invalid_result',
    'oauth.start did not return an authorization URL',
  );
}
