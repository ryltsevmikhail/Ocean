/**
 * Qualification status (plain types + pinned-constant cross-check).
 *
 * The status is deliberately Effect-free so the public transport's declaration
 * graph stays plain. `assessQualification` does not trust `identity.ok` alone:
 * it re-checks the expected AND actual digests against the pinned patched chunk
 * constant, so a forged/synthetic identity cannot qualify execution.
 */
import type { ServicePluginTransportQualification } from '@runnets/application';

import { PINNED_IDENTITIES, PINNED_SDK_CHUNK_SHA256 } from './pinned-identity.js';
import type { InstalledSdkChunkIdentity } from './pinned-identity.js';

export type ExecutorTransportQualificationReason =
  'invalid_options' | 'execution_not_enabled' | 'pinned_chunk_mismatch' | 'pinned_chunk_unreadable';

/** Status with the extra facts a host needs to explain a refusal. */
export interface ExecutorTransportStatus extends ServicePluginTransportQualification {
  readonly reason: ExecutorTransportQualificationReason | null;
  readonly requested: boolean;
  readonly installedChunkSha256: string | null;
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

export class ExecutorTransportOpenError extends Error {
  readonly reason: ExecutorTransportQualificationReason;

  constructor(reason: ExecutorTransportQualificationReason, message: string) {
    super(message);
    this.name = 'ExecutorTransportOpenError';
    this.reason = reason;
  }
}

/** Freeze a status (and its identity map) so a caller cannot flip it at runtime. */
export function freezeStatus(status: ExecutorTransportStatus): ExecutorTransportStatus {
  return Object.freeze({
    ...status,
    identities: Object.freeze({ ...status.identities }),
  });
}

/**
 * Pure qualification decision. Execution qualifies only when it was requested,
 * the chunk read succeeded, and both the expected and the observed digest equal
 * the pinned patched-chunk constant.
 */
export function assessQualification(input: {
  readonly requested: boolean;
  readonly identity: InstalledSdkChunkIdentity;
}): ExecutorTransportStatus {
  const base = {
    requested: input.requested,
    identities: PINNED_IDENTITIES,
    installedChunkSha256: input.identity.actualSha256,
  } as const;
  if (!input.requested) {
    return freezeStatus({ ...base, qualified: false, reason: 'execution_not_enabled' });
  }
  if (!input.identity.ok) {
    return freezeStatus({
      ...base,
      qualified: false,
      reason:
        input.identity.actualSha256 === null ? 'pinned_chunk_unreadable' : 'pinned_chunk_mismatch',
    });
  }
  if (
    input.identity.expectedSha256 !== PINNED_SDK_CHUNK_SHA256 ||
    input.identity.actualSha256 !== PINNED_SDK_CHUNK_SHA256
  ) {
    // `ok: true` is not enough: the comparison must be against the pinned
    // constant, not against a caller-supplied expectation.
    return freezeStatus({ ...base, qualified: false, reason: 'pinned_chunk_mismatch' });
  }
  return freezeStatus({ ...base, qualified: true, reason: null });
}
