/**
 * Qualified, fail-closed service-plugin transport.
 *
 * This is the package's public entry point. It implements Ocean's
 * `ServicePluginTransportPort` over the pinned Executor SDK, and refuses to
 * dispatch unless:
 *
 * 1. the caller explicitly enabled execution at construction (disabled by
 *    default, so no product path can reach the network in this task), and
 * 2. the installed SDK chunk hashes to the exact patched bundle from the
 *    qualification run (a missing or drifted bundle is `unqualified`).
 *
 * Discovery and invocation are bounded by the application limits and never
 * retried. The host that owns catalog/connection persistence is not part of
 * this task; `fromHost` is the internal seam the package's tests (and the next
 * host layer) use to wrap an already-created host.
 */
import { ServicePluginDiscoveryRefusedError } from '@runnets/application';
import type {
  ServicePluginCatalog,
  ServicePluginDiscoveryOptions,
  ServicePluginInvokeOptions,
  ServicePluginInvokeOutcome,
  ServicePluginInvocation,
  ServicePluginTarget,
  ServicePluginTransportPort,
  ServicePluginTransportQualification,
} from '@runnets/application';

import { runDiscovery } from './discovery.js';
import { createExecutorHost } from './sdk-boundary.js';
import type { ExecutorHost } from './host-types.js';
import { notStarted, runInvocation } from './invoke.js';
import { PINNED_IDENTITIES, verifyInstalledSdkChunk } from './pinned-identity.js';
import type { InstalledSdkChunkIdentity } from './pinned-identity.js';

export type ExecutorTransportQualificationReason =
  'invalid_options' | 'execution_not_enabled' | 'pinned_chunk_mismatch' | 'pinned_chunk_unreadable';

/** Status with the extra facts a host needs to explain a refusal. */
export interface ExecutorTransportStatus extends ServicePluginTransportQualification {
  readonly reason: ExecutorTransportQualificationReason | null;
  readonly requested: boolean;
  readonly installedChunkSha256: string | null;
}

export class ExecutorTransportOpenError extends Error {
  readonly reason: ExecutorTransportQualificationReason;

  constructor(reason: ExecutorTransportQualificationReason, message: string) {
    super(message);
    this.name = 'ExecutorTransportOpenError';
    this.reason = reason;
  }
}

export interface ExecutorTransportOpenOptions {
  /** Executor tenant scope (an opaque host identity, not a secret). */
  readonly tenantId: string;
  /** Executor subject scope; the owner of the connections being addressed. */
  readonly subjectId: string;
  /** Exact origins this transport may talk to. Never credentials. */
  readonly allowedOrigins: readonly string[];
  /**
   * Execution is OFF unless this is exactly `true`; no product path sets it in
   * this task. Construction still verifies the pinned bundle when enabled.
   */
  readonly enableExecution?: boolean;
}

/** Pure qualification decision; exported for the fail-closed regression test. */
export function assessQualification(input: {
  readonly requested: boolean;
  readonly identity: InstalledSdkChunkIdentity;
}): ExecutorTransportStatus {
  const identities = PINNED_IDENTITIES;
  const base = {
    requested: input.requested,
    identities,
    installedChunkSha256: input.identity.actualSha256,
  } as const;
  if (!input.requested) {
    return { ...base, qualified: false, reason: 'execution_not_enabled' };
  }
  if (!input.identity.ok) {
    return {
      ...base,
      qualified: false,
      reason:
        input.identity.actualSha256 === null ? 'pinned_chunk_unreadable' : 'pinned_chunk_mismatch',
    };
  }
  return { ...base, qualified: true, reason: null };
}

/** Reject construction-time configuration that cannot be enforced. */
function validateOpenOptions(options: ExecutorTransportOpenOptions): void {
  if (options.tenantId.trim().length === 0 || options.subjectId.trim().length === 0) {
    throw new ExecutorTransportOpenError('invalid_options', 'tenantId and subjectId are required');
  }
  if (options.allowedOrigins.length === 0) {
    throw new ExecutorTransportOpenError(
      'invalid_options',
      'at least one allowed origin is required',
    );
  }
}

function refusalCode(
  status: ExecutorTransportStatus,
): 'execution_disabled' | 'transport_unqualified' {
  return status.reason === 'execution_not_enabled' ? 'execution_disabled' : 'transport_unqualified';
}

export class ExecutorServicePluginTransport implements ServicePluginTransportPort {
  private readonly host: ExecutorHost;
  private readonly current: ExecutorTransportStatus;
  private closed = false;

  private constructor(host: ExecutorHost, status: ExecutorTransportStatus) {
    this.host = host;
    this.current = status;
  }

  /** Public factory. Execution stays disabled unless explicitly enabled. */
  static async open(
    options: ExecutorTransportOpenOptions,
  ): Promise<ExecutorServicePluginTransport> {
    validateOpenOptions(options);
    const requested = options.enableExecution === true;
    const identity = await verifyInstalledSdkChunk();
    const status = assessQualification({ requested, identity });
    if (!status.qualified) {
      const reason = status.reason ?? 'pinned_chunk_mismatch';
      throw new ExecutorTransportOpenError(
        reason,
        `Executor transport cannot enable execution: ${reason}`,
      );
    }
    const host = await createExecutorHost({
      tenantId: options.tenantId,
      subjectId: options.subjectId,
      allowedOrigins: options.allowedOrigins,
    });
    return new ExecutorServicePluginTransport(host, status);
  }

  /**
   * Internal seam: wrap an existing host (tests today; the Task 5 host layer
   * that owns catalog/connection persistence later).
   */
  static async fromHost(
    host: ExecutorHost,
    options: {
      readonly enableExecution?: boolean;
      readonly identity?: InstalledSdkChunkIdentity;
    } = {},
  ): Promise<ExecutorServicePluginTransport> {
    const identity = options.identity ?? (await verifyInstalledSdkChunk());
    const status = assessQualification({
      requested: options.enableExecution === true,
      identity,
    });
    return new ExecutorServicePluginTransport(host, status);
  }

  /** Qualification plus the observed installed-chunk digest. */
  status(): ExecutorTransportStatus {
    return this.current;
  }

  qualification(): ServicePluginTransportQualification {
    return this.current;
  }

  async discover(
    target: ServicePluginTarget,
    options: ServicePluginDiscoveryOptions = {},
  ): Promise<ServicePluginCatalog> {
    this.assertOpen();
    if (!this.current.qualified) {
      throw new ServicePluginDiscoveryRefusedError(
        refusalCode(this.current),
        `Executor transport is not qualified: ${this.current.reason ?? 'unqualified'}`,
      );
    }
    return runDiscovery(this.host, target, {
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async invoke(
    target: ServicePluginTarget,
    invocation: ServicePluginInvocation,
    options: ServicePluginInvokeOptions = {},
  ): Promise<ServicePluginInvokeOutcome> {
    this.assertOpen();
    if (!this.current.qualified) {
      return notStarted(
        invocation.invocationId,
        refusalCode(this.current),
        `Executor transport is not qualified: ${this.current.reason ?? 'unqualified'}`,
      );
    }
    return runInvocation(this.host, target, invocation, options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.host.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Executor transport is closed');
  }
}
