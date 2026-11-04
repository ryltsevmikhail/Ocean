/**
 * In-package test seam (never exported from the package entry point).
 *
 * Tests need to wrap an already-configured host with a chosen qualification
 * status. `assessQualification` still cross-checks the pinned patched-chunk
 * constant, so a forged identity cannot produce a qualified status here; the
 * only way to get one is a real installed chunk matching the pin.
 */
import { createBackend } from './admission.js';
import type { ExecutorHost } from './host-types.js';
import { verifyInstalledSdkChunk } from './pinned-identity.js';
import type { InstalledSdkChunkIdentity } from './pinned-identity.js';
import { assessQualification } from './status.js';
import { createInternalTransport } from './transport.js';
import type { ExecutorServicePluginTransport } from './transport.js';

export async function createTestTransport(
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
  return createInternalTransport(createBackend(host), status);
}
