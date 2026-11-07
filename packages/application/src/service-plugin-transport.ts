/**
 * Service-plugin transport port.
 *
 * Historical service-plugin records and their inert compatibility services use
 * this application-owned seam. Its plain TypeScript types remain available for
 * old profiles; current execution uses ServiceCallTransportPort and direct MCP.
 *
 * The contract is fail-closed:
 *
 * - `observed` — the dispatch completed and a business result came back. That
 *   includes a vendor error the upstream itself returned (for example an HTTP
 *   401 auth wall or an MCP `isError` payload): the request was answered, so
 *   the application can record the result. It never means "the effect was
 *   applied" for a write; the upstream result says what it says.
 * - `not_started` — the adapter proved before dispatching that no request
 *   could have been made (disabled/unqualified transport, unknown connection
 *   or tool, arguments over the request cap, an already-exhausted deadline).
 *   The caller can safely report that nothing happened.
 * - `uncertain` — the dispatch may have reached the upstream but its effect is
 *   unknown (timeout, interrupted, transport loss, 5xx, unclassifiable
 *   failure). The caller MUST treat the invocation as possibly executed, MUST
 *   NOT retry it automatically and MUST NOT infer that it failed. This is the
 *   only safe classification for a lost response after a write; the adapter
 *   never retries.
 */

/** Owner of a connection row; mirrors the transport's two ownership scopes. */
export type ServicePluginOwner = 'user' | 'org';

/** JSON-only value carried across the port. */
export type ServicePluginJson =
  | null
  | boolean
  | number
  | string
  | readonly ServicePluginJson[]
  | { readonly [key: string]: ServicePluginJson };

/** One installed connection the application may address. */
export interface ServicePluginTarget {
  readonly integrationId: string;
  readonly connectionId: string;
  readonly owner: ServicePluginOwner;
  /** Immutable Ocean authority snapshot, supplied only by the runtime owner. */
  readonly authority?: {
    readonly generation: number;
    readonly endpoint: string;
    readonly pluginVersion: string;
    readonly adapterVersion: string;
    readonly credentialReference: string;
  };
}

/** A tool as exposed to the application: name, summary and JSON input schema. */
export interface ServicePluginTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ServicePluginJson;
}

/**
 * Account identity observed for the connection. `verified` is true only when
 * the identity came from a persisted upstream health observation; a
 * user-supplied label is reported unverified.
 */
export interface ServicePluginAccountIdentity {
  readonly identity: string | null;
  readonly verified: boolean;
}

/**
 * Completeness of a catalog the transport returned.
 *
 * Only `'complete'` is ever returned: an incomplete, stale or failed upstream
 * listing is a `ServicePluginDiscoveryRefusedError('catalog_incomplete')`, not
 * a successful catalog. A returned empty catalog therefore means the upstream
 * authoritatively reported no tools, never "the listing failed".
 *
 * TASK 5 OBLIGATION: the catalog/connection service must publish a
 * `schemaDigest` only from a catalog successfully returned by `discover()` (or
 * an equivalent complete observation of the same connection generation). It
 * must treat a refused discovery, a missing observation, or any persisted
 * snapshot as NOT authoritative: never derive a digest, publish a catalog or
 * grant access from an incomplete/unobserved listing, and re-discover before
 * relying on digest-change revocation.
 */
export type ServicePluginCatalogCompleteness = 'complete';

/** Bounded, freshly observed tool catalog for one target connection. */
export interface ServicePluginCatalog {
  readonly target: ServicePluginTarget;
  readonly tools: readonly ServicePluginTool[];
  /**
   * sha256 hex over the canonical JSON of the tools (sorted by name, object
   * keys sorted). A digest change between discovery and dispatch means the
   * catalog moved; the application re-confirms grants before dispatching.
   */
  readonly schemaDigest: string;
  readonly account: ServicePluginAccountIdentity;
  /** ISO-8601 instant the catalog was observed. */
  readonly discoveredAt: string;
  /** Always `'complete'`; incomplete listings are refusals, never catalogs. */
  readonly completeness: ServicePluginCatalogCompleteness;
}

/** A single invocation; `invocationId` is the caller's pre-dispatch journal claim. */
export interface ServicePluginInvocation {
  readonly invocationId: string;
  readonly tool: string;
  readonly arguments: ServicePluginJson;
}

/** Per-operation bounds; omitted fields use the adapter defaults below. */
export interface ServicePluginDiscoveryOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

/** Per-operation bounds; omitted fields use the adapter defaults below. */
export interface ServicePluginInvokeOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

/** Hard limits. The application owns them; the adapter enforces them. */
export { SERVICE_PLUGIN_MAX_TOOLS, SERVICE_PLUGIN_MAX_DISCOVERY_BYTES } from '@runnets/domain';
export const SERVICE_PLUGIN_MAX_REQUEST_BYTES = 1024 * 1024;
export const SERVICE_PLUGIN_CALL_DEADLINE_MS = 30_000;
export const SERVICE_PLUGIN_DISCOVERY_DEADLINE_MS = 15_000;

/** Why a returned business result is an `observed` outcome. */
export type ServicePluginObservedCode = 'ok' | 'vendor_error';

/** Refusals the adapter proved before dispatching anything. */
export type ServicePluginNotStartedCode =
  | 'execution_disabled'
  | 'transport_unqualified'
  | 'connection_unknown'
  | 'tool_unknown'
  | 'arguments_too_large'
  | 'invalid_arguments'
  | 'catalog_unavailable'
  | 'cancelled'
  | 'deadline_exhausted';

/** Failures whose effect is unknown; never retried. */
export type ServicePluginUncertainCode =
  | 'deadline_exceeded'
  | 'interrupted'
  | 'transport_failure'
  | 'upstream_failure'
  | 'internal_failure';

export interface ServicePluginObservedOutcome {
  readonly kind: 'observed';
  readonly invocationId: string;
  readonly code: ServicePluginObservedCode;
  readonly result: ServicePluginJson;
  /** Upstream tool failure code when `code` is `vendor_error`; else null. */
  readonly vendorErrorCode: string | null;
}

export interface ServicePluginNotStartedOutcome {
  readonly kind: 'not_started';
  readonly invocationId: string;
  readonly code: ServicePluginNotStartedCode;
  /** Non-secret diagnostic safe to log. */
  readonly detail: string;
}

export interface ServicePluginUncertainOutcome {
  readonly kind: 'uncertain';
  readonly invocationId: string;
  readonly code: ServicePluginUncertainCode;
  /** Non-secret diagnostic safe to log. */
  readonly detail: string;
}

export type ServicePluginInvokeOutcome =
  ServicePluginObservedOutcome | ServicePluginNotStartedOutcome | ServicePluginUncertainOutcome;

/** Refusals and failures raised by `discover`; the caller keeps its old catalog. */
export type ServicePluginDiscoveryFailureCode =
  | 'execution_disabled'
  | 'transport_unqualified'
  | 'connection_unknown'
  | 'too_many_tools'
  | 'discovery_too_large'
  /** The upstream listing failed/was incomplete; the old catalog is not authoritative. */
  | 'catalog_incomplete'
  | 'deadline_exceeded'
  | 'interrupted'
  | 'transport_failure'
  | 'internal_failure';

/** Discovery is fail-closed: any non-catalog answer is this typed refusal. */
export class ServicePluginDiscoveryRefusedError extends Error {
  readonly code: ServicePluginDiscoveryFailureCode;

  constructor(code: ServicePluginDiscoveryFailureCode, message: string) {
    super(message);
    this.name = 'ServicePluginDiscoveryRefusedError';
    this.code = code;
  }
}

/** Whether this transport may dispatch, and the exact pinned identities behind it. */
export interface ServicePluginTransportQualification {
  readonly qualified: boolean;
  /** Null when qualified; otherwise why execution is refused. */
  readonly reason: string | null;
  /** Pinned package/patch identities, lowest-level entries first. */
  readonly identities: Readonly<Record<string, string>>;
}

/**
 * Application-facing transport. Implementations are bound to one fixed origin
 * allowlist and one isolated runtime; they never retry an invocation.
 */
export interface ServicePluginTransportPort {
  /** Local session proof only: never provisions or performs network I/O. */
  readonly sessions?: ServicePluginSessions;
  /** Current qualification; safe to call at any time, performs no I/O. */
  qualification(): ServicePluginTransportQualification;
  /** Bounded discovery. Throws `ServicePluginDiscoveryRefusedError` to fail closed. */
  discover(
    target: ServicePluginTarget,
    options?: ServicePluginDiscoveryOptions,
  ): Promise<ServicePluginCatalog>;
  /** Exactly one dispatch attempt, classified. Never throws for dispatch failures. */
  invoke(
    target: ServicePluginTarget,
    invocation: ServicePluginInvocation,
    options?: ServicePluginInvokeOptions,
  ): Promise<ServicePluginInvokeOutcome>;
}

export interface ServicePluginSessions {
  ready(target: ServicePluginTarget): boolean;
  /** The exact discovery receipt still has its original credential snapshot. */
  current(catalog: ServicePluginCatalog): boolean;
  /** Activate only after durable publication succeeds; no candidate is executable earlier. */
  publish(catalog: ServicePluginCatalog, target: ServicePluginTarget): boolean;
}
