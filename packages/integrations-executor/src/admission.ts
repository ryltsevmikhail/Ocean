/**
 * Internal admission: option validation, pinned-chunk verification, host
 * creation and backend wiring.
 *
 * Everything that needs the Executor/Effect runtime lives here (or below);
 * the public transport only ever sees the plain `ExecutorTransportBackend` and
 * a frozen `ExecutorTransportStatus`.
 */
import { runDiscovery } from './discovery.js';
import type { ExecutorHost } from './host-types.js';
import { runInvocation } from './invoke.js';
import { normalizeAllowedOrigins } from './origins.js';
import { verifyInstalledSdkChunk } from './pinned-identity.js';
import { createExecutorHost } from './sdk-boundary.js';
import type { ExecutorTransportBackend } from './backend.js';
import type { ExecutorTransportOpenOptions, ExecutorTransportStatus } from './status.js';
import { ExecutorTransportOpenError, assessQualification, freezeStatus } from './status.js';

export interface Admission {
  readonly backend: ExecutorTransportBackend;
  readonly status: ExecutorTransportStatus;
}

/** Wrap an already-created host (tests / the future Task 5 host layer). */
export function createBackend(host: ExecutorHost): ExecutorTransportBackend {
  return {
    discover: (target, options) => runDiscovery(host, target, options),
    invoke: (target, invocation, options) => runInvocation(host, target, invocation, options),
    close: () => host.close(),
  };
}

function invalidOptions(message: string): never {
  throw new ExecutorTransportOpenError('invalid_options', message);
}

/** Validate construction options and normalise the origin allowlist. */
function admittedOrigins(options: ExecutorTransportOpenOptions): readonly string[] {
  if (options.tenantId.trim().length === 0 || options.subjectId.trim().length === 0) {
    invalidOptions('tenantId and subjectId are required');
  }
  try {
    return normalizeAllowedOrigins(options.allowedOrigins);
  } catch (error) {
    invalidOptions(
      `allowedOrigins is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Verify the installed pinned bundle on every admission, build the host and
 * return the backend plus a frozen qualification status. Refuses (throws
 * `ExecutorTransportOpenError`) unless execution was explicitly requested and
 * the installed chunk matches the pinned patched digest.
 */
export async function admit(options: ExecutorTransportOpenOptions): Promise<Admission> {
  const allowedOrigins = admittedOrigins(options);
  const identity = await verifyInstalledSdkChunk();
  const status = assessQualification({
    requested: options.enableExecution === true,
    identity,
  });
  if (!status.qualified) {
    throw new ExecutorTransportOpenError(
      status.reason ?? 'pinned_chunk_mismatch',
      `Executor transport cannot enable execution: ${status.reason ?? 'unqualified'}`,
    );
  }
  const host = await createExecutorHost({
    tenantId: options.tenantId,
    subjectId: options.subjectId,
    allowedOrigins,
  });
  return { backend: createBackend(host), status: freezeStatus(status) };
}
